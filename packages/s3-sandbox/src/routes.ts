import * as bucketCtrl from "./controllers/bucket.ts"
import * as objectCtrl from "./controllers/object.ts"
import * as serviceCtrl from "./controllers/service.ts"
import authenticationMiddleware from "./middleware/authentication.ts"
import corsMiddleware from "./middleware/cors.ts"
import responseHeaderOverrideMiddleware from "./middleware/response-header-override.ts"
import websiteMiddleware from "./middleware/website.ts"
import S3Error from "./models/error.ts"
import { runMiddleware, type S3Context, type S3Middleware } from "./types.ts"

// NOTE: The below is only an approximation of S3's behavior
// For the most part, S3 will complain if you attempt a bucket method on an object, but
// it won't consistently reject actions on buckets that are supported by objects (and vice-versa).
const queryMethod = (methods: string[]) =>
	async function selectQueryMethod(
		ctx: S3Context,
		next: () => Promise<unknown>,
	) {
		const matchedMethods = methods.filter((method) => method in ctx.s3Query)
		if (matchedMethods.length > 1) {
			throw new S3Error(
				"InvalidArgument",
				`Conflicting query string parameters: ${matchedMethods.join(", ")}`,
				{
					ArgumentName: "ResourceType",
					ArgumentValue: matchedMethods[0],
				},
			)
		}
		if (matchedMethods.length === 1) {
			ctx.params.queryMethod = matchedMethods[0]!
		}
		await next()
		if (ctx.state.methodIsNotAllowed) {
			throw new S3Error(
				"MethodNotAllowed",
				"The specified method is not allowed against this resource.",
				{
					Method: ctx.method.toUpperCase(),
					ResourceType: (ctx.params.queryMethod ?? "").toUpperCase(),
				},
			)
		}
	}

async function bucketPut(ctx: S3Context) {
	if (ctx.params.queryMethod) {
		await bucketCtrl.bucketExists(ctx)
	}
	switch (ctx.params.queryMethod) {
		case undefined:
			return bucketCtrl.putBucket(ctx)
		case "cors":
			return bucketCtrl.putBucketCors(ctx)
		case "website":
			return bucketCtrl.putBucketWebsite(ctx)
		case "accelerate":
		case "acl":
		case "analytics":
		case "encryption":
		case "inventory":
		case "lifecycle":
		case "logging":
		case "metrics":
		case "notification":
		case "policy":
		case "publicAccessBlock":
		case "replication":
		case "requestPayment":
		case "tagging":
		case "versioning":
			throw new S3Error(
				"NotImplemented",
				"A parameter you provided implies functionality that is not implemented",
			)
		default:
			ctx.state.methodIsNotAllowed = true
	}
}

function bucketPost(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return objectCtrl.postObject(ctx)
		case "delete":
			return objectCtrl.deleteMultipleObjects(ctx)
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function bucketGet(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return bucketCtrl.getBucket(ctx)
		case "cors":
			return bucketCtrl.getBucketCors(ctx)
		case "location":
			return bucketCtrl.getBucketLocation(ctx)
		case "website":
			return bucketCtrl.getBucketWebsite(ctx)
		case "acl":
		case "analytics":
		case "encryption":
		case "inventory":
		case "lifecycle":
		case "logging":
		case "metrics":
		case "notification":
		case "object-lock":
		case "policyStatus":
		case "publicAccessBlock":
		case "replication":
		case "requestPayment":
		case "tagging":
		case "uploads":
		case "versioning":
			throw new S3Error(
				"NotImplemented",
				"A parameter you provided implies functionality that is not implemented",
			)
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function bucketDelete(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return bucketCtrl.deleteBucket(ctx)
		case "cors":
			return bucketCtrl.deleteBucketCors(ctx)
		case "website":
			return bucketCtrl.deleteBucketWebsite(ctx)
		case "analysis":
		case "encryption":
		case "lifecycle":
		case "publicAccessBlock":
		case "metrics":
		case "policy":
		case "replication":
		case "tagging":
			throw new S3Error(
				"NotImplemented",
				"A parameter you provided implies functionality that is not implemented",
			)
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function objectPut(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return "x-amz-copy-source" in ctx.s3Headers
				? objectCtrl.putObjectCopy(ctx)
				: objectCtrl.putObject(ctx)
		case "uploadId":
			return "x-amz-copy-source" in ctx.s3Headers
				? objectCtrl.uploadPartCopy(ctx)
				: objectCtrl.uploadPart(ctx)
		case "tagging":
			return objectCtrl.putObjectTagging(ctx)
		case "acl":
			throw new S3Error(
				"NotImplemented",
				"A parameter you provided implies functionality that is not implemented",
			)
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function objectPost(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case "uploadId":
			return objectCtrl.completeMultipartUpload(ctx)
		case "uploads":
			return objectCtrl.initiateMultipartUpload(ctx)
		case undefined:
		case "select":
			throw new S3Error("NotImplemented")
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function objectGet(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return objectCtrl.getObject(ctx)
		case "acl":
			return objectCtrl.getObjectAcl(ctx)
		case "tagging":
			return objectCtrl.getObjectTagging(ctx)
		case "legal-hold":
		case "retention":
		case "torrent":
			throw new S3Error(
				"NotImplemented",
				"A parameter you provided implies functionality that is not implemented",
			)
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

function objectDelete(ctx: S3Context) {
	switch (ctx.params.queryMethod) {
		case undefined:
			return objectCtrl.deleteObject(ctx)
		case "tagging":
			throw new S3Error("NotImplemented")
		default:
			ctx.state.methodIsNotAllowed = true
	}

	return undefined
}

const objectMethods = [
	...new Set([...bucketCtrl.METHODS, ...objectCtrl.METHODS]),
].toSorted()
const authentication = authenticationMiddleware()
const cors = corsMiddleware()
const website = websiteMiddleware()
const override = responseHeaderOverrideMiddleware()
const bucketQuery = queryMethod(bucketCtrl.METHODS)
const objectQuery = queryMethod(objectMethods)
const bucketHandlers: Record<string, S3Middleware> = {
	DELETE: bucketDelete,
	GET: bucketGet,
	HEAD: bucketGet,
	POST: bucketPost,
	PUT: bucketPut,
}
const objectHandlers: Record<string, S3Middleware> = {
	DELETE: objectDelete,
	GET: objectGet,
	HEAD: objectGet,
	POST: objectPost,
	PUT: objectPut,
}

/** Dispatch S3 resources from the raw path, preserving escaped bytes for signatures. */
export default async function route(ctx: S3Context): Promise<void> {
	const match = /^\/([^/]+)(?:\/(.*))?$/.exec(ctx.path)
	if (!match) {
		await runMiddleware(ctx, [
			authentication,
			async () => {
				if (ctx.path === "/" && ["GET", "HEAD"].includes(ctx.method))
					await serviceCtrl.getService(ctx)
			},
		])
		return
	}
	try {
		ctx.params.bucket = decodeURIComponent(match[1] ?? "")
		ctx.params.key = decodeURIComponent(match[2] ?? "")
	} catch {
		throw new S3Error("InvalidURI", "Could not parse the specified URI.")
	}
	const isObject = ctx.params.key !== ""
	const handler = (isObject ? objectHandlers : bucketHandlers)[ctx.method]
	const operation: S3Middleware = async () => {
		if (isObject || (handler && ctx.method !== "PUT"))
			await bucketCtrl.bucketExists(ctx)
		await runMiddleware(ctx, [
			isObject ? objectQuery : bucketQuery,
			...(handler ? [handler] : []),
		])
	}
	await runMiddleware(ctx, [cors, website, authentication, override, operation])
}
