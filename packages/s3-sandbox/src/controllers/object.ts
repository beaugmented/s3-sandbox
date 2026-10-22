import { deleteKeys, uploadParts } from "../protocol-xml.ts"
import type { Readable } from "node:stream"
import { iso8601FromInstant, isoNow, parseDate } from "../temporal-tools.ts"
import { createMultipartParser } from "../multipart/parser.ts"
import { asError } from "../error-tools.ts"
import crypto from "node:crypto"
import { once } from "node:events"
import { URL } from "node:url"

import { DUMMY_ACCOUNT } from "../models/account.ts"
import { TaggingConfiguration } from "../models/config.ts"
import S3Error from "../models/error.ts"
import { createS3Event, type S3EventData } from "../models/event.ts"
import S3Object from "../models/object.ts"
import { aws4SignatureBodyParser } from "../signature/v4.ts"
import { type S3Context } from "../types.ts"
import type { ObjectRangeOptions } from "../stores/filesystem.ts"
import { capitalizeHeader, utf8BodyParser, xmlBodyParser } from "../utils.ts"

function triggerS3Event(ctx: S3Context, eventData: S3EventData) {
	ctx.app.emit(
		"event",
		createS3Event(eventData, {
			reqHeaders: ctx.s3Headers,
			sourceIp: ctx.ip,
		}),
	)
}

/*
 * Operations on Objects
 * The following methods correspond to operations you can perform on Amazon S3 objects.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectOps.html
 */

export const METHODS = [
	"acl",
	"legal-hold",
	"retention",
	"select",
	"tagging",
	"torrent",
	"uploadId",
	"uploads",
]

/**
 * Delete the keys listed in the XML request, reporting missing keys as deleted.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/multiobjectdeleteapi.html}
 */
export async function deleteMultipleObjects(ctx: S3Context) {
	const body = await xmlBodyParser(ctx)
	const keys = deleteKeys(body)
	await Promise.all(
		keys.map(async (key: string) => {
			const objectExists = await ctx.store.existsObject(ctx.params.bucket, key)
			if (!objectExists) return

			await ctx.store.deleteObject(ctx.params.bucket, key)
			ctx.logger.info(
				'Deleted object "%s" in bucket "%s"',
				key,
				ctx.params.bucket,
			)
		}),
	)
	ctx.body = {
		DeleteResult: {
			"@": { xmlns: "http://s3.amazonaws.com/doc/2006-03-01/" },
			Deleted: keys.map((key: string) => ({ Key: key })),
		},
	}
}

/**
 * Delete an object if present and return 204, including for missing keys.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectDELETE.html}
 */
export async function deleteObject(ctx: S3Context) {
	try {
		if (await ctx.store.existsObject(ctx.params.bucket, ctx.params.key)) {
			await ctx.store.deleteObject(ctx.params.bucket, ctx.params.key)
			triggerS3Event(ctx, {
				bucket: ctx.params.bucket,
				eventType: "Delete",
				S3Item: { key: ctx.params.key },
			})
		}
		ctx.status = 204
	} catch (err: unknown) {
		ctx.logger.error(
			'Error deleting object "%s" from bucket "%s"',
			ctx.params.key,
			ctx.params.bucket,
			err,
		)
		throw err
	}
}

/**
 * Retrieve object content and metadata, supporting byte ranges and HEAD requests.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGET.html}
 */
export async function getObject(ctx: S3Context) {
	const options: ObjectRangeOptions = {}
	const match = /^bytes=(\d*)-(\d*)$/.exec(ctx.get("range"))
	if (match && (match[1] || match[2])) {
		// Clamp arbitrarily long decimal ranges before passing them to Node's file streams.
		if (match[1]) {
			options.start = Math.min(Number(match[1]), Number.MAX_SAFE_INTEGER)
			if (match[2])
				options.end = Math.min(Number(match[2]), Number.MAX_SAFE_INTEGER)
		} else {
			options.suffixLength = Math.min(Number(match[2]), Number.MAX_SAFE_INTEGER)
		}
	}

	const key = ctx.params.key
	const object = await ctx.store.getObject(ctx.params.bucket, key, options)
	if (!object) {
		throw new S3Error("NoSuchKey", "The specified key does not exist.", {
			Key: key,
		})
	}

	// Range request was out of range
	if (object.range && !object.content) {
		throw new S3Error(
			"InvalidRange",
			"The requested range is not satisfiable",
			{
				RangeRequested: ctx.get("range"),
				ActualObjectSize: object.size,
			},
		)
	}

	const noneMatch = ctx.s3Headers["if-none-match"]
	if (noneMatch && (noneMatch === object.metadata.etag || noneMatch === "*")) {
		ctx.status = 304
		return
	}
	const modifiedSince = ctx.s3Headers["if-modified-since"]
	const modifiedSinceInstant = parseDate(modifiedSince || "")
	if (
		modifiedSinceInstant &&
		Temporal.Instant.compare(modifiedSinceInstant, object.lastModifiedDate) >= 0
	) {
		ctx.status = 304
		return
	}

	ctx.set("Accept-Ranges", "bytes")

	for (const header of Object.keys(object.metadata)) {
		ctx.set(capitalizeHeader(header)!, String(object.metadata[header]))
	}
	if (object.range) {
		ctx.set(
			"Content-Range",
			`bytes ${object.range.start}-${object.range.end}/${object.size}`,
		)
		ctx.length = object.range.end + 1 - object.range.start
		ctx.status = 206
	} else {
		ctx.length = object.size
		ctx.status = 200
	}

	if (ctx.method === "HEAD") {
		object.content?.destroy()
	} else {
		ctx.body = object.content
	}
}

/**
 * Return a fixed ACL response for the dummy account.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGETacl.html}
 */
export async function getObjectAcl(ctx: S3Context) {
	ctx.body = {
		AccessControlPolicy: {
			"@": { xmlns: "http://doc.s3.amazonaws.com/2006-03-01/" },
			Owner: {
				ID: DUMMY_ACCOUNT.id,
				DisplayName: DUMMY_ACCOUNT.displayName,
			},
			AccessControlList: {
				Grant: {
					Grantee: {
						"@": {
							"xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
							"xsi:type": "CanonicalUser",
						},
						ID: "abc",
						DisplayName: "You",
					},
				},
				Permission: "FULL_CONTROL",
			},
		},
	}
}

/**
 * GET Object tagging
 * This implementation of the GET operation returns the tags associated with an object. You
 * send the GET request against the tagging subresource associated with the object.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGETtagging.html}
 *
 * @param ctx
 * @returns when the tagging response has been prepared
 */
export async function getObjectTagging(ctx: S3Context): Promise<void> {
	const key = ctx.params.key
	const exists = await ctx.store.existsObject(ctx.params.bucket, key)
	if (!exists) {
		throw new S3Error("NoSuchKey", "The specified key does not exist.", {
			Key: key,
		})
	}

	const config = await ctx.store.getSubresource(
		ctx.params.bucket,
		key,
		"tagging",
	)

	ctx.type = "application/xml"
	ctx.body = (config || TaggingConfiguration.EMPTY).toXML()
}

/**
 * POST Object
 * The POST operation adds an object to a specified bucket using HTML forms.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPOST.html}
 */
export async function postObject(ctx: S3Context) {
	if (!ctx.is("multipart/form-data")) {
		throw new S3Error(
			"PreconditionFailed",
			"At least one of the pre-conditions you specified did not hold",
			{
				Condition:
					"Bucket POST must be of the enclosure-type multipart/form-data",
			},
		)
	}
	let activeParser: ReturnType<typeof createMultipartParser> | undefined
	try {
		let successRedirect: string | undefined
		let successStatus = 204
		let fileCount = 0

		const parser = createMultipartParser(ctx.s3Headers)
		activeParser = parser
		const onRequestError = (error: unknown) => parser.destroy(asError(error))
		const onAborted = () => parser.destroy(new Error("Upload request aborted"))
		ctx.req.once("error", onRequestError)
		ctx.req.once("aborted", onAborted)
		ctx.req.once("close", () => {
			ctx.req.off("error", onRequestError)
			ctx.req.off("aborted", onAborted)
		})
		parser.once("close", () => ctx.req.unpipe(parser))
		const finishedPromise = once(parser, "finish")
		const object = await Promise.race([
			finishedPromise.then(() => null),
			new Promise<S3Object>((resolve, reject) => {
				let key: string | undefined
				const metadata: Record<string, string> = {}

				const errorHandler = (err: unknown) => {
					parser.off("field", fieldHandler)
					parser.off("file", fileHandler)
					reject(err)
				}
				const fieldHandler = (fieldname: string, value: string) => {
					if (fileCount) {
						// Ignore all text fields submitted after the first file part.
						return
					}
					if (typeof fieldname !== "string" || typeof value !== "string") {
						parser.destroy(
							new S3Error(
								"MalformedPOSTRequest",
								"Invalid multipart field name or encoding",
							),
						)
						return
					}
					switch (fieldname) {
						case "key":
							key = value
							break
						case "success_action_redirect":
							successRedirect = value
							break
						case "redirect":
							// redirect field name is deprecated and is always overridden by
							// success_action_redirect if present
							if (successRedirect === undefined) {
								successRedirect = value
							}
							break
						case "success_action_status":
							if (value === "200" || value === "201") {
								successStatus = Number(value)
							}
							break
						case "AWSAccessKeyId":
						case "acl":
						case "policy":
						case "tagging":
							// unimplemented
							break
						default:
							metadata[fieldname.toLowerCase()] = value
							break
					}
				}
				const fileHandler = (fieldname: string, file: Readable) => {
					file.on("error", errorHandler)
					if (fieldname !== "file" || fileCount++) {
						return file.resume()
					}
					resolve(new S3Object(ctx.params.bucket, key!, file, metadata))

					return undefined
				}

				parser.on("error", errorHandler)
				parser.on("field", fieldHandler)
				parser.on("file", fileHandler)

				ctx.req.pipe(parser)
			}),
		])

		if (!object) {
			throw new S3Error(
				"InvalidArgument",
				"POST requires exactly one file upload per request.",
				{
					ArgumentName: "file",
					ArgumentValue: fileCount,
				},
			)
		}

		if (object.key === undefined) {
			throw new S3Error(
				"InvalidArgument",
				"Bucket POST must contain a field named 'key'.  If it is specified, " +
					"please check the order of the fields",
				{
					ArgumentName: "key",
					ArgumentValue: "",
				},
			)
		}

		if (!object.key.length) {
			throw new S3Error(
				"InvalidArgument",
				"User key must have a length greater than 0.",
				{
					ArgumentName: "key",
					ArgumentValue: "",
				},
			)
		}

		const { md5, size } = await ctx.store.putObject(object)
		await finishedPromise
		ctx.logger.info(
			'Stored object "%s" in bucket "%s" successfully',
			object.key,
			object.bucket,
		)
		triggerS3Event(ctx, {
			bucket: ctx.params.bucket,
			eventType: "Post",
			S3Item: new S3Object(object.bucket, object.key, null, {
				"content-length": size,
				etag: JSON.stringify(md5),
			}),
		})

		if (fileCount > 1) {
			ctx.logger.warn(
				"A POST request for object %s in bucket %s contained %d files in the " +
					"multipart body. This request would be rejected by real S3 servers.",
				object.key,
				object.bucket,
				fileCount,
			)
		}

		ctx.etag = md5

		if (successRedirect) {
			ctx.status = 303
			const location = new URL(successRedirect)
			location.searchParams.append("bucket", object.bucket)
			location.searchParams.append("key", object.key)
			location.searchParams.append("etag", ctx.getResponseHeader("ETag"))
			ctx.set("Location", location.href)
		} else {
			ctx.status = successStatus
			const location = new URL(ctx.originalUrl, `${ctx.protocol}://${ctx.host}`)
			if (!location.pathname.endsWith("/")) {
				location.pathname += "/"
			}
			location.pathname += object.key
			ctx.set("Location", location.href)
		}

		if (ctx.status === 201) {
			ctx.body = {
				PostResponse: {
					Location: ctx.getResponseHeader("Location"),
					Bucket: object.bucket,
					Key: object.key,
					Etag: JSON.stringify(md5),
				},
			}
		} else {
			ctx.body = ""
			ctx.type = ""
		}
	} catch (err: unknown) {
		activeParser?.destroy(asError(err))
		ctx.logger.error(
			'Error uploading object to bucket "%s"',
			ctx.params.bucket,
			err,
		)
		throw err
	}
}

/**
 * PUT Object
 * This implementation of the PUT operation adds an object to a bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPUT.html}
 */
export async function putObject(ctx: S3Context) {
	const content = aws4SignatureBodyParser(ctx)
	const object = new S3Object(
		ctx.params.bucket,
		ctx.params.key,
		content,
		ctx.s3Headers,
	)
	try {
		const { md5, size } = await ctx.store.putObject(object)
		ctx.logger.info(
			'Stored object "%s" in bucket "%s" successfully',
			object.key,
			object.bucket,
		)
		triggerS3Event(ctx, {
			bucket: ctx.params.bucket,
			eventType: "Put",
			S3Item: new S3Object(object.bucket, object.key, null, {
				"content-length": size,
				etag: JSON.stringify(md5),
			}),
		})
		ctx.etag = md5
		ctx.body = ""
	} catch (err: unknown) {
		ctx.logger.error(
			'Error uploading object "%s" to bucket "%s"',
			object.key,
			object.bucket,
			err,
		)
		throw err
	}
}

/**
 * PUT Object - Copy
 * This implementation of the PUT operation creates a copy of an object that is already stored in
 * Amazon S3. A PUT copy operation is the same as performing a GET and then a PUT. Adding the
 * request header, x-amz-copy-source, makes the PUT operation copy the source object into the
 * destination bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPUT.html}
 */
export async function putObjectCopy(ctx: S3Context) {
	let copySource = decodeURI(ctx.get("x-amz-copy-source"))
	copySource = copySource.startsWith("/") ? copySource.slice(1) : copySource
	const [srcBucket = "", ...keyParts] = copySource.split("/")
	const srcKey = keyParts.join("/")

	const destBucket = ctx.params.bucket
	const destKey = ctx.params.key

	try {
		const bucket = await ctx.store.getBucket(srcBucket)
		if (!bucket) {
			ctx.logger.error('No bucket found for "%s"', srcBucket)
			throw new S3Error("NoSuchBucket", "The specified bucket does not exist", {
				BucketName: srcBucket,
			})
		}

		if (!(await ctx.store.existsObject(srcBucket, srcKey))) {
			ctx.logger.error(
				'Object "%s" in bucket "%s" does not exist',
				srcKey,
				srcBucket,
			)
			throw new S3Error("NoSuchKey", "The specified key does not exist.", {
				Key: srcKey,
			})
		}
		const replaceMetadata =
			ctx.s3Headers["x-amz-metadata-directive"] === "REPLACE"
		if (srcBucket === destBucket && srcKey === destKey && !replaceMetadata) {
			throw new S3Error(
				"InvalidRequest",
				"This copy request is illegal because it is trying to copy an object " +
					"to itself without changing the object's metadata, storage class, " +
					"website redirect location or encryption attributes.",
			)
		}

		const metadata = await ctx.store.copyObject(
			srcBucket,
			srcKey,
			destBucket,
			destKey,
			replaceMetadata ? ctx.s3Headers : null,
		)

		ctx.logger.info(
			'Copied object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
			srcKey,
			srcBucket,
			destBucket,
			destKey,
		)
		triggerS3Event(ctx, {
			bucket: ctx.params.bucket,
			eventType: "Copy",
			S3Item: new S3Object(destBucket, destKey, null, metadata),
		})
		ctx.body = {
			CopyObjectResult: {
				LastModified: iso8601FromInstant(parseDate(metadata["last-modified"])),
				ETag: metadata.etag,
			},
		}
	} catch (err: unknown) {
		ctx.logger.error(
			'Error copying object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
			srcKey,
			srcBucket,
			destBucket,
			destKey,
		)
		throw err
	}
}

/**
 * PUT Object tagging
 * This implementation of the PUT operation uses the tagging subresource to add a set of tags
 * to an existing object.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPUTtagging.html}
 *
 * @param ctx
 * @returns when the tagging configuration has been stored
 */
export async function putObjectTagging(ctx: S3Context): Promise<void> {
	const key = ctx.params.key
	const bucket = ctx.params.bucket
	const exists = await ctx.store.existsObject(bucket, key)
	if (!exists) {
		throw new S3Error("NoSuchKey", "The specified key does not exist.", {
			Key: key,
		})
	}

	try {
		const body = await utf8BodyParser(ctx)
		const config = TaggingConfiguration.validate(body)
		await ctx.store.putSubresource(bucket, key, config)
		ctx.body = ""
	} catch (err: unknown) {
		ctx.logger.error(
			'Error tagging object "%s" in bucket "%s"',
			key,
			bucket,
			err,
		)
		throw err
	}
}

/**
 * Complete Multipart Upload
 * This operation completes a multipart upload by assembling previously uploaded parts.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/mpUploadComplete.html}
 */
export async function completeMultipartUpload(ctx: S3Context) {
	const body = await xmlBodyParser(ctx)
	const parts = uploadParts(body)
	try {
		const { md5, size } = await ctx.store.putObjectMultipart(
			ctx.params.bucket,
			ctx.s3Query.uploadId ?? "",
			parts,
		)
		ctx.logger.info(
			'Stored object "%s" in bucket "%s" successfully',
			ctx.params.key,
			ctx.params.bucket,
		)
		triggerS3Event(ctx, {
			bucket: ctx.params.bucket,
			eventType: "Post",
			S3Item: new S3Object(ctx.params.bucket, ctx.params.key, null, {
				etag: JSON.stringify(md5),
				"content-length": size,
			}),
		})
		ctx.body = {
			CompleteMultipartUploadResult: {
				Location: ctx.href.split("?")[0],
				Bucket: ctx.params.bucket,
				Key: ctx.params.key,
				ETag: JSON.stringify(md5),
			},
		}
	} catch (err: unknown) {
		ctx.logger.error(
			'Error uploading object "%s" to bucket "%s"',
			ctx.params.key,
			ctx.params.bucket,
			err,
		)
		throw err
	}
}

/**
 * Create a multipart upload and return its ID for subsequent part requests.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/mpUploadInitiate.html}
 */
export async function initiateMultipartUpload(ctx: S3Context) {
	const uploadId = crypto.randomBytes(16).toString("hex")
	await ctx.store.initiateUpload(
		ctx.params.bucket,
		ctx.params.key,
		uploadId,
		ctx.s3Headers,
	)
	ctx.body = {
		InitiateMultipartUploadResult: {
			Bucket: ctx.params.bucket,
			Key: ctx.params.key,
			UploadId: uploadId,
		},
	}
}

/**
 * Store an upload part, replacing any existing part with the same number.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/mpUploadUploadPart.html}
 */
export async function uploadPart(ctx: S3Context) {
	const content = aws4SignatureBodyParser(ctx)
	try {
		const { md5 } = await ctx.store.putPart(
			ctx.params.bucket,
			ctx.s3Query.uploadId ?? "",
			Number(ctx.s3Query.partNumber),
			content,
		)
		ctx.logger.info(
			'Stored part %s of %s in bucket "%s" successfully',
			Number(ctx.s3Query.partNumber),
			ctx.s3Query.uploadId ?? "",
			ctx.params.bucket,
		)
		ctx.etag = md5
		ctx.body = ""
	} catch (err: unknown) {
		ctx.logger.error(
			'Error uploading part %s of %s to bucket "%s"',
			ctx.s3Query.partNumber,
			ctx.s3Query.uploadId ?? "",
			ctx.params.bucket,
			err,
		)
		throw err
	}
}

export async function uploadPartCopy(ctx: S3Context) {
	let copySource = decodeURI(ctx.get("x-amz-copy-source"))
	copySource = copySource.startsWith("/") ? copySource.slice(1) : copySource
	const [srcBucket = "", ...keyParts] = copySource.split("/")
	const srcKey = keyParts.join("/")

	const bucket = await ctx.store.getBucket(srcBucket)
	if (!bucket) {
		ctx.logger.error('No bucket found for "%s"', srcBucket)
		throw new S3Error("NoSuchBucket", "The specified bucket does not exist", {
			BucketName: srcBucket,
		})
	}

	const options: { start?: number; end?: number } = {}
	if ("x-amz-copy-source-range" in ctx.s3Headers) {
		const match = /^bytes=(\d+)-(\d+)$/.exec(ctx.get("x-amz-copy-source-range"))
		if (!match) {
			throw new S3Error(
				"InvalidArgument",
				"The x-amz-copy-source-range value must be of the form bytes=first-last where first and last are the zero-based offsets of the first and last bytes to copy",
				{
					ArgumentName: "x-amz-copy-source-range",
					ArgumentValue: ctx.get("x-amz-copy-source-range"),
				},
			)
		}
		options.start = Number(match[1])
		options.end = Number(match[2])
	}

	const object = await ctx.store.getObject(srcBucket, srcKey, options)
	if (!object) {
		throw new S3Error("NoSuchKey", "The specified key does not exist.", {
			Key: srcKey,
		})
	}

	// Range request was out of range
	if (
		object.range &&
		(!object.content || object.range.end < (options.end ?? Infinity))
	) {
		if (object.content) object.content?.destroy()
		throw new S3Error(
			"InvalidArgument",
			`Range specified is not valid for source object of size: ${object.size}`,
			{
				ArgumentName: "x-amz-copy-source-range",
				ArgumentValue: ctx.get("x-amz-copy-source-range"),
			},
		)
	}

	try {
		if (!object.content)
			throw new S3Error(
				"InvalidRange",
				"The requested range is not satisfiable",
			)
		const { md5 } = await ctx.store.putPart(
			ctx.params.bucket,
			ctx.s3Query.uploadId ?? "",
			Number(ctx.s3Query.partNumber),
			object.content,
		)
		ctx.logger.info(
			'Copied part %s of %s in bucket "%s" successfully',
			ctx.s3Query.partNumber,
			ctx.s3Query.uploadId ?? "",
			ctx.params.bucket,
		)
		ctx.etag = md5
		ctx.body = {
			CopyPartResult: {
				LastModified: isoNow(),
				ETag: JSON.stringify(md5),
			},
		}
	} catch (err: unknown) {
		ctx.logger.error(
			'Error copying part %s of %s to bucket "%s"',
			ctx.s3Query.partNumber,
			ctx.s3Query.uploadId ?? "",
			ctx.params.bucket,
			err,
		)
		throw err
	}
}
