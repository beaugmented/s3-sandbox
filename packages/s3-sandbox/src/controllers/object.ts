import { Temporal } from "@js-temporal/polyfill"
import { iso8601FromInstant, isoNow, parseDate } from "../temporal-tools.ts"
import Busboy from "busboy"
import crypto from "node:crypto"
import { once } from "node:events"
import { URL } from "node:url"
import { asArray } from "../utils.ts"

import { DUMMY_ACCOUNT } from "../models/account.ts"
import { TaggingConfiguration } from "../models/config.ts"
import S3Error from "../models/error.ts"
import S3Event from "../models/event.ts"
import S3Object from "../models/object.ts"
import { aws4SignatureBodyParser } from "../signature/v4.ts"
import { type S3Context } from "../types.ts"
import { capitalizeHeader, utf8BodyParser, xmlBodyParser } from "../utils.ts"

function triggerS3Event(ctx: S3Context, eventData: any) {
	ctx.app.emit(
		"event",
		new S3Event(eventData, {
			reqHeaders: ctx.headers,
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
 * Delete Multiple Objects
 * The Multi-Object Delete request contains a list of up to 1000 keys that you want to delete. In
 * the XML, you provide the object key names, and optionally, version IDs if you want to delete a
 * specific version of the object from a versioning-enabled bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/multiobjectdeleteapi.html}
 */
export const deleteMultipleObjects = async function deleteMultipleObjects(
	ctx: S3Context,
) {
	await xmlBodyParser(ctx)
	if (!ctx.request.body.Delete || !ctx.request.body.Delete.Object) {
		throw new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against " +
				"our published schema.",
		)
	}
	const keys = asArray(ctx.request.body.Delete.Object).map((o: any) => o.Key)
	await Promise.all(
		keys.map(async (key: any) => {
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
			Deleted: keys.map((k: any) => ({ Key: k })),
		},
	}
}

/**
 * DELETE Object
 * The DELETE operation removes the null version (if there is one) of an object and inserts a
 * delete marker, which becomes the current version of the object. If there isn't a null version,
 * Amazon S3 does not remove any objects.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectDELETE.html}
 */
export const deleteObject = async function deleteObject(ctx: S3Context) {
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
	} catch (err: any) {
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
 * GET Object
 * This implementation of the GET operation retrieves objects from Amazon S3. To use GET, you must
 * have READ access to the object. If you grant READ access to the anonymous user, you can return
 * the object without using an authorization header.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGET.html}
 */
export const getObject = async function getObject(ctx: S3Context) {
	const options: { start?: number; end?: number } = {}
	if (ctx.get("range").startsWith("bytes=")) {
		const [start, end] = ctx.get("range").replace("bytes=", "").split("-")
		options.start = Number(start)
		if (end) options.end = Number(end)
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

	const noneMatch = ctx.headers["if-none-match"]
	if (noneMatch && (noneMatch === object.metadata.etag || noneMatch === "*")) {
		ctx.status = 304
		return
	}
	const modifiedSince = ctx.headers["if-modified-since"]
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
 * GET Object ACL
 * This implementation of the GET operation uses the acl subresource to return the access control
 * list (ACL) of an object. To use this operation, you must have READ_ACP access to the object.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGETacl.html}
 */
export const getObjectAcl = async function getObjectAcl(ctx: S3Context) {
	// NOTE: This is a stub implementation
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
export const getObjectTagging = async function getObjectTagging(
	ctx: S3Context,
): Promise<void> {
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
export const postObject = async function postObject(ctx: S3Context) {
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
	try {
		let successRedirect: string | undefined
		let successStatus = 204
		let fileCount = 0

		const busboy = Busboy({ headers: ctx.headers })
		const finishedPromise = once(busboy, "finish")
		const object = await Promise.race([
			finishedPromise.then(() => null),
			new Promise<S3Object>((resolve, reject) => {
				let key: string | undefined
				const metadata: Record<string, string> = {}

				const errorHandler = (err: any) => {
					busboy.off("field", fieldHandler)
					busboy.off("file", fileHandler)
					reject(err)
				}
				const fieldHandler = (fieldname: any, value: any) => {
					if (fieldname === "file") {
						// busboy will identify parts as fields if they both lack a filename
						// and have a content-type other than application/octet-stream
						const file = Buffer.from(value)
						fileCount++
						resolve(new S3Object(ctx.params.bucket, key!, file, metadata))
					}
					if (fileCount) {
						// ignore everything submitted after the first 'file' field
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
				const fileHandler = (fieldname: any, file: any) => {
					if (fieldname !== "file" || fileCount++) {
						return file.resume()
					}
					resolve(new S3Object(ctx.params.bucket, key!, file, metadata))
				}

				busboy.once("error", errorHandler)
				busboy.on("field", fieldHandler)
				busboy.on("file", fileHandler)

				ctx.req.pipe(busboy)
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

		await finishedPromise

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
			location.searchParams.append("etag", ctx.response.get("ETag"))
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
					Location: ctx.response.get("Location"),
					Bucket: object.bucket,
					Key: object.key,
					Etag: JSON.stringify(md5),
				},
			}
		} else {
			ctx.body = ""
			ctx.type = ""
		}
	} catch (err: any) {
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
export const putObject = async function putObject(ctx: S3Context) {
	aws4SignatureBodyParser(ctx)
	const object = new S3Object(
		ctx.params.bucket,
		ctx.params.key,
		ctx.request.body,
		ctx.headers,
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
	} catch (err: any) {
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
export const putObjectCopy = async function putObjectCopy(ctx: S3Context) {
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
			ctx.headers["x-amz-metadata-directive"] === "REPLACE"
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
			replaceMetadata ? ctx.headers : null,
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
	} catch (err: any) {
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
export const putObjectTagging = async function putObject(
	ctx: S3Context,
): Promise<void> {
	const key = ctx.params.key
	const bucket = ctx.params.bucket
	const exists = await ctx.store.existsObject(bucket, key)
	if (!exists) {
		throw new S3Error("NoSuchKey", "The specified key does not exist.", {
			Key: key,
		})
	}

	try {
		await utf8BodyParser(ctx)
		const config = TaggingConfiguration.validate(ctx.request.body)
		await ctx.store.putSubresource(bucket, key, config)
		ctx.body = ""
	} catch (err: any) {
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
export const completeMultipartUpload = async function completeMultipartUpload(
	ctx: S3Context,
) {
	await xmlBodyParser(ctx)
	if (
		!ctx.request.body.CompleteMultipartUpload ||
		!ctx.request.body.CompleteMultipartUpload.Part
	) {
		throw new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against " +
				"our published schema.",
		)
	}
	const parts = asArray(ctx.request.body.CompleteMultipartUpload.Part).map(
		(part: any) => ({
			number: Number(part.PartNumber),
			// S3 removes all double quotes when comparing etags
			etag: part.ETag.replace(/"/g, ""),
		}),
	)
	try {
		const { md5, size } = await ctx.store.putObjectMultipart(
			ctx.params.bucket,
			ctx.query.uploadId,
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
	} catch (err: any) {
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
 * Initiate Multipart Upload
 * This operation initiates a multipart upload and returns an upload ID. This upload ID is used to
 * associate all of the parts in the specific multipart upload. You specify this upload ID in each
 * of your subsequent upload part requests. You also include this upload ID in the final request to
 * either complete or abort the multipart upload request.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/mpUploadInitiate.html}
 */
export const initiateMultipartUpload = async function initiateMultipartUpload(
	ctx: S3Context,
) {
	const uploadId = crypto.randomBytes(16).toString("hex")
	await ctx.store.initiateUpload(
		ctx.params.bucket,
		ctx.params.key,
		uploadId,
		ctx.headers,
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
 * Upload Part
 * This operation uploads a part in a multipart upload. Part numbers can be any number from 1 to
 * 10,000, inclusive. A part number uniquely identifies a part and also defines its position within
 * the object being created. If you upload a new part using the same part number that was used with
 * a previous part, the previously uploaded part is overwritten. Each part must be at least 5 MB in
 * size, except the last part. There is no size limit on the last part of your multipart upload.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/mpUploadUploadPart.html}
 */
export const uploadPart = async function uploadPart(ctx: S3Context) {
	aws4SignatureBodyParser(ctx)
	try {
		const { md5 } = await ctx.store.putPart(
			ctx.params.bucket,
			ctx.query.uploadId,
			ctx.query.partNumber,
			ctx.request.body,
		)
		ctx.logger.info(
			'Stored part %s of %s in bucket "%s" successfully',
			ctx.query.partNumber,
			ctx.query.uploadId,
			ctx.params.bucket,
		)
		ctx.etag = md5
		ctx.body = ""
	} catch (err: any) {
		ctx.logger.error(
			'Error uploading part %s of %s to bucket "%s"',
			ctx.query.partNumber,
			ctx.query.uploadId,
			ctx.params.bucket,
			err,
		)
		throw err
	}
}

export const uploadPartCopy = async function uploadPartCopy(ctx: S3Context) {
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
	if ("x-amz-copy-source-range" in ctx.headers) {
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
		const { md5 } = await ctx.store.putPart(
			ctx.params.bucket,
			ctx.query.uploadId,
			ctx.query.partNumber,
			object.content,
		)
		ctx.logger.info(
			'Copied part %s of %s in bucket "%s" successfully',
			ctx.query.partNumber,
			ctx.query.uploadId,
			ctx.params.bucket,
		)
		ctx.etag = md5
		ctx.body = {
			CopyPartResult: {
				LastModified: isoNow(),
				ETag: JSON.stringify(md5),
			},
		}
	} catch (err: any) {
		ctx.logger.error(
			'Error copying part %s of %s to bucket "%s"',
			ctx.query.partNumber,
			ctx.query.uploadId,
			ctx.params.bucket,
			err,
		)
		throw err
	}
}
