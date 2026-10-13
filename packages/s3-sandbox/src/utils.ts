import * as he from "he"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import xmlParser from "./xml.ts"

import S3Error from "./models/error.ts"
import { type S3Context } from "./types.ts"

export const walk = function* walk(
	dir: string,
	recurseFilter?: (path: string) => boolean,
): Generator<string> {
	for (const filename of fs.readdirSync(dir)) {
		const filePath = path.posix.join(dir, filename)
		const stats = fs.statSync(filePath)
		if (!stats.isDirectory()) {
			yield filePath
		} else if (!recurseFilter || recurseFilter(filePath)) {
			yield* walk(filePath, recurseFilter)
		}
	}
}

export const capitalizeHeader = function (header: string) {
	const exceptions: Record<string, string> = {
		"content-md5": "Content-MD5",
		dnt: "DNT",
		etag: "ETag",
		"last-event-id": "Last-Event-ID",
		tcn: "TCN",
		te: "TE",
		"www-authenticate": "WWW-Authenticate",
		"x-dnsprefetch-control": "X-DNSPrefetch-Control",
	}

	header = header.toLowerCase()

	if (header in exceptions) return exceptions[header]
	if (header.startsWith("x-amz-")) return header

	// Capitalize the first letter of each word
	return header
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("-")
}

export const concatStreams = function (streams: any) {
	const passThrough = new PassThrough()
	streams = [...streams]
	const pipeNext = (stream: any) => {
		if (!stream) return passThrough.end()

		stream.once("end", () => pipeNext(streams.shift()))
		stream.pipe(passThrough, { end: false })
	}
	pipeNext(streams.shift())
	return passThrough
}

/**
 * URI-encodes a string according to RFC 3986. This is what AWS uses for
 * S3 resource URIs.
 *
 * @param {string} string
 */
export const encodeURIComponentRFC3986 = function (string: any) {
	return encodeURIComponent(string).replace(
		/[!'()*]/g,
		(ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
	)
}

export const getXmlRootTag = function (xml: string) {
	return xmlParser.getRootTag(xml.toString())
}

export const randomBase64String = function (length: number) {
	return crypto
		.randomBytes(Math.ceil((length * 3) / 4))
		.toString("base64")
		.slice(0, length)
}

export const randomHexString = function (length: number) {
	return crypto
		.randomBytes(Math.ceil(length / 2))
		.toString("hex")
		.slice(0, length)
}

export {
	parseDate,
	parseISO8601String,
	toISO8601String,
} from "./temporal-tools.ts"

/**
 * Reads a request body to as parsed XML.
 *
 * @param {Koa.Context} ctx
 */
export const xmlBodyParser = async function xmlBodyParser(ctx: S3Context) {
	const { req } = ctx
	const xmlString = await new Promise<string>((resolve, reject) => {
		let payload = ""
		req.on("data", (data: any) => (payload += data.toString("utf8")))
		req.on("end", () => resolve(payload))
		req.on("error", reject)
	})
	if (xmlParser.validate(xmlString) !== true) {
		throw new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against " +
				"our published schema.",
		)
	}
	ctx.request.body = xmlParser.parse(xmlString, {
		tagValueProcessor: (a) => he.decode(a),
	})
}

/**
 * Reads a request body stream to a string.
 *
 * @param {Koa.Context} ctx
 */
export const utf8BodyParser = async function (ctx: S3Context) {
	const { req } = ctx
	ctx.request.body = await new Promise((resolve, reject) => {
		let payload = ""
		req.on("data", (data: any) => (payload += data.toString("utf8")))
		req.on("end", () => resolve(payload))
		req.on("error", reject)
	})
}

export const ensureDir = async function (dirPath: string) {
	const options = { recursive: true, mode: 0o0755 }
	if (process.platform === "win32") {
		options.mode = 0o0755
	}
	await fs.promises.mkdir(dirPath, options)
}

export function asArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value]
}
