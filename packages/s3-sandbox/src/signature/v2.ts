import { Temporal } from "@js-temporal/polyfill"
import S3Error from "../models/error.ts"

export function parseHeader(headers: any) {
	const [, ...components] = headers.authorization.split(" ")

	if (components.length !== 1) {
		throw new S3Error(
			"InvalidArgument",
			"Authorization header is invalid -- one and only one ' ' (space) required",
			{
				ArgumentName: "Authorization",
				ArgumentValue: headers.authorization,
			},
		)
	}

	const match = /([^:]*):([^:]+)/.exec(components[0])
	if (!match) {
		throw new S3Error(
			"InvalidArgument",
			"AWS authorization header is invalid.  Expected AwsAccessKeyId:signature",
			{
				ArgumentName: "Authorization",
				ArgumentValue: headers.authorization,
			},
		)
	}

	return { accessKeyId: match[1], signatureProvided: match[2] }
}

export function parseQuery(query: any) {
	// authentication param names are case-sensitive
	if (!("Expires" in query) || !("AWSAccessKeyId" in query)) {
		throw new S3Error(
			"AccessDenied",
			"Query-string authentication requires the Signature, Expires and " +
				"AWSAccessKeyId parameters",
		)
	}

	const request = {
		signature: {
			version: 2,
			algorithm: "sha1",
			encoding: "base64",
		},
		accessKeyId: query.AWSAccessKeyId,
		expires: Number(query.Expires),
		signatureProvided: query.Signature,
	}

	const serverTime = Temporal.Now.instant()
	let expiresTime: Temporal.Instant
	try {
		expiresTime = Temporal.Instant.fromEpochMilliseconds(
			Math.trunc(request.expires * 1000),
		)
	} catch {
		throw new S3Error(
			"AccessDenied",
			`Invalid date (should be seconds since epoch): ${query.Expires}`,
		)
	}

	if (Temporal.Instant.compare(serverTime, expiresTime) > 0) {
		throw new S3Error("AccessDenied", "Request has expired", {
			Expires: expiresTime.toString({ smallestUnit: "second" }),
			ServerTime: serverTime.toString({ smallestUnit: "second" }),
		})
	}

	return request
}

/**
 * Generates a string to be signed for signature version 2.
 *
 * @param canonicalRequest
 */
export function getStringToSign(canonicalRequest: {
	method: string
	contentMD5?: string
	contentType?: string
	timestamp: string | number
	amzHeaders: string[]
	querystring: string
	uri: string
}): string {
	return [
		canonicalRequest.method,
		canonicalRequest.contentMD5,
		canonicalRequest.contentType,
		canonicalRequest.timestamp,
		...canonicalRequest.amzHeaders,
		canonicalRequest.querystring
			? `${canonicalRequest.uri}?${canonicalRequest.querystring}`
			: canonicalRequest.uri,
	].join("\n")
}
