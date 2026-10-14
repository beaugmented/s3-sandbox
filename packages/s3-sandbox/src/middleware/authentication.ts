import type { AuthRequest, V2Request } from "../signature/types.ts"
import mapKeys from "lodash/mapKeys.js"
import pickBy from "lodash/pickBy.js"
import { createHmac } from "node:crypto"

import AWSAccount from "../models/account.ts"
import S3Error from "../models/error.ts"
import { RESPONSE_HEADERS } from "./response-header-override.ts"

import * as v2 from "../signature/v2.ts"
import * as v4 from "../signature/v4.ts"
import { type S3Context } from "../types.ts"
import { encodeURIComponentRFC3986, parseDate } from "../utils.ts"

const SUBRESOURCES: Record<string, number> = {
	acl: 1,
	accelerate: 1,
	analytics: 1,
	cors: 1,
	lifecycle: 1,
	delete: 1,
	inventory: 1,
	location: 1,
	logging: 1,
	metrics: 1,
	notification: 1,
	partNumber: 1,
	policy: 1,
	requestPayment: 1,
	replication: 1,
	restore: 1,
	tagging: 1,
	torrent: 1,
	uploadId: 1,
	uploads: 1,
	versionId: 1,
	versioning: 1,
	versions: 1,
	website: 1,
}

/**
 * Middleware that verifies signed HTTP requests
 *
 * This also processes request and response headers specified via query params.
 *
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/dev/RESTAuthentication.html}
 */
export default () =>
	async function authentication(ctx: S3Context, next: () => Promise<unknown>) {
		if (ctx.state.website) {
			// skip for static website requests
			return next()
		}

		if (ctx.method === "OPTIONS") {
			// skip for CORS OPTION requests
			return next()
		}

		const amzQueryHeaders = pickBy(
			mapKeys(ctx.s3Query, (_value, key) => key.toLowerCase()),
			(_value, key) => key.startsWith("x-amz-"),
		)
		// x-amz-* values specified in query params take precedence over those in the headers
		Object.assign(ctx.s3Headers, amzQueryHeaders)

		const mechanisms = {
			header: "authorization" in ctx.s3Headers,
			queryV2: "Signature" in ctx.s3Query,
			queryV4: "X-Amz-Algorithm" in ctx.s3Query,
		}

		const mechanismCount = Object.values(mechanisms).filter(Boolean).length
		if (mechanismCount === 0) {
			return next()
		}
		if (mechanismCount !== 1) {
			throw new S3Error(
				"InvalidArgument",
				"Only one auth mechanism allowed; only the X-Amz-Algorithm query " +
					"parameter, Signature query string parameter or the Authorization " +
					"header should be specified",
				{
					ArgumentName: "Authorization",
					ArgumentValue: ctx.get("Authorization"),
				},
			)
		}

		let canonicalizedResource = ctx.mountPath || ""
		if (ctx.params.bucket) {
			// the following behavior is derived from the behavior of the JS aws-sdk
			if (ctx.state.vhost) {
				canonicalizedResource = "/" + ctx.params.bucket + canonicalizedResource
			} else {
				canonicalizedResource += "/" + ctx.params.bucket
			}
			if (ctx.params.key) {
				canonicalizedResource += "/" + ctx.params.key
			}
		} else {
			canonicalizedResource += "/"
		}
		canonicalizedResource = canonicalizedResource
			.split("/")
			.map(encodeURIComponentRFC3986)
			.join("/")

		// begin parsing for each part of the signature algorithm and the rest of the canonical request
		const request: AuthRequest = mechanisms.header
			? parseHeader(ctx.s3Headers)
			: mechanisms.queryV2
				? v2.parseQuery(ctx.s3Query)
				: mechanisms.queryV4
					? v4.parseQuery(ctx.s3Query)
					: (() => {
							throw new S3Error(
								"InvalidArgument",
								"Unsupported authentication mechanism",
							)
						})()

		const canonicalizedQueryString = Object.entries(ctx.s3Query)
			.filter(([param]) => {
				if (
					mechanisms.queryV2 &&
					["Signature", "AWSAccessKeyId", "Expires"].includes(param)
				) {
					return false
				}
				if (mechanisms.queryV4 && param === "X-Amz-Signature") {
					return false
				}
				return (
					request.signature.version !== 2 ||
					SUBRESOURCES[param] ||
					RESPONSE_HEADERS[param]
				)
			})
			.map(
				([param, value]) =>
					request.signature.version === 2
						? [param, value].slice(0, value ? 2 : 1).join("=") // v2 signing doesn't encode values in the signature calculation
						: [param, value].map(encodeURIComponent).join("="), // v4 signing requires the = be present even when there's no value
			)
			.toSorted()
			.join("&")

		const canonicalizedAmzHeaders = Object.keys(ctx.s3Headers)
			.filter((headerName) => headerName.startsWith("x-amz-"))
			.toSorted()
			.map(
				(headerName) =>
					`${headerName}:${(ctx.s3Headers[headerName] ?? "").replace(/ +/g, " ")}`,
			)

		const canonicalRequest = {
			method:
				ctx.method === "OPTIONS"
					? ctx.get("Access-Control-Request-Method")
					: ctx.method,
			contentMD5: ctx.get("Content-MD5"),
			contentType: ctx.get("Content-Type"),
			headers: ctx.s3Headers,
			// TODO: verify v2 header timestamp canonicalization; see docs/implementation-review.md.
			timestamp: isV2Request(request) ? request.expires : request.time,
			uri:
				request.signature.version === 4
					? (ctx.mountPath || "") + ctx.originalUrl.split("?")[0]
					: canonicalizedResource,
			querystring: canonicalizedQueryString,
			amzHeaders: canonicalizedAmzHeaders,
		}

		const account = AWSAccount.registry.get(request.accessKeyId)
		if (!account) {
			throw new S3Error(
				"InvalidAccessKeyId",
				"The AWS Access Key Id you provided does not exist in our records.",
				{ AWSAccessKeyId: request.accessKeyId },
			)
		}

		const secretKey = account.accessKeys.get(request.accessKeyId)
		if (secretKey === undefined) throw new S3Error("InvalidAccessKeyId")
		let stringToSign: string
		let signingKey: string | Buffer
		if (isV2Request(request)) {
			stringToSign = v2.getStringToSign(canonicalRequest)
			signingKey = secretKey
		} else {
			stringToSign = v4.getStringToSign(
				{ ...canonicalRequest, timestamp: request.time },
				{
					credential: request.credential,
					signedHeaders: request.signedHeaders,
				},
			)
			signingKey = v4.getSigningKey(
				secretKey,
				request.credential.date,
				request.credential.region,
				request.credential.service,
			)
		}
		const calculatedSignature = createHmac(
			request.signature.algorithm,
			signingKey,
		)
			.update(stringToSign, "utf8")
			.digest(request.signature.encoding)

		if (request.signatureProvided === calculatedSignature) {
			ctx.state.account = account
		}

		if (!ctx.state.account) {
			if (ctx.app.allowMismatchedSignatures) {
				ctx.state.account = account
			} else {
				throw new S3Error(
					"SignatureDoesNotMatch",
					"The request signature we calculated does not match the signature " +
						"you provided. Check your key and signing method.",
					{
						AWSAccessKeyId: request.accessKeyId,
						StringToSign: stringToSign,
						StringToSignBytes: Buffer.from(stringToSign)
							.toString("hex")
							.match(/../g)!
							.join(" "),
					},
				)
			}
		}

		return next()
	}

function isV2Request(request: AuthRequest): request is V2Request {
	return request.signature.version === 2
}

function parseHeader(headers: Record<string, string>): AuthRequest {
	const time = headers["x-amz-date"] || headers.date || ""
	const [algorithm = ""] = (headers.authorization ?? "").split(" ")
	let request: AuthRequest
	switch (algorithm.toUpperCase()) {
		case "AWS":
			request = {
				time,
				signature: { version: 2, algorithm: "sha1", encoding: "base64" },
				...v2.parseHeader(headers),
			}
			break
		case "AWS4-HMAC-SHA256":
			request = {
				time,
				signature: { version: 4, algorithm: "sha256", encoding: "hex" },
				...v4.parseHeader(headers),
			}
			break
		default:
			throw new S3Error("InvalidArgument", "Unsupported Authorization Type", {
				ArgumentName: "Authorization",
				ArgumentValue: headers.authorization,
			})
	}

	const serverTime = Temporal.Now.instant()
	const requestTime = parseDate(time)
	if (!requestTime) {
		throw new S3Error(
			"AccessDenied",
			"AWS authentication requires a valid Date or x-amz-date header",
		)
	}

	if (
		Math.abs(serverTime.epochMilliseconds - requestTime.epochMilliseconds) >
		900000
	) {
		// 15 minutes
		throw new S3Error(
			"RequestTimeTooSkewed",
			"The difference between the request time and the current time is too large.",
			{
				RequestTime: time,
				ServerTime: serverTime.toString({ smallestUnit: "second" }),
			},
		)
	}
	return request
}
