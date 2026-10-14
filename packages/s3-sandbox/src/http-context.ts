import { Readable } from "node:stream"
import type { IncomingMessage } from "node:http"
import { parse } from "node:querystring"
import { TLSSocket } from "node:tls"
import type S3Sandbox from "./s3rver.ts"
import type { S3State } from "./types.ts"
import type S3Bucket from "./models/bucket.ts"
import type { XmlRecord } from "./xml-record.ts"
import S3Error from "./models/error.ts"
import { j2xParser } from "./xml.ts"
import * as he from "he"

type ResponseBody = string | Buffer | Readable | Record<string, unknown> | null
const xmlBuilder = new j2xParser({
	ignoreAttributes: false,
	attrNodeName: "@",
	tagValueProcessor: (value) => he.escape(value),
})

/** S3 protocol state, independent of the HTTP framework and its URL normalization. */
export class S3HttpContext {
	readonly app: S3Sandbox
	readonly req: IncomingMessage & { baseUrl?: string }
	readonly state: S3State = {}
	readonly headers: IncomingMessage["headers"]
	readonly originalUrl: string
	readonly mountPath: string
	readonly query: ReturnType<typeof parse>
	readonly responseHeaders = new Headers()
	path: string
	params = { bucket: "", key: "", queryMethod: undefined as string | undefined }
	bucket?: S3Bucket
	s3Query: Record<string, string> = {}
	s3Headers: Record<string, string> = {}
	requestBody: string | Readable | XmlRecord | undefined
	handleError: (error: unknown) => Promise<void>
	private responseBody: ResponseBody = null
	private responseStatus = 404
	private explicitStatus = false

	constructor(app: S3Sandbox, req: IncomingMessage & { baseUrl?: string }) {
		this.app = app
		this.req = req
		this.headers = req.headers
		this.originalUrl = req.url ?? "/"
		this.mountPath = req.baseUrl ?? ""
		const question = this.originalUrl.indexOf("?")
		this.path =
			question < 0 ? this.originalUrl : this.originalUrl.slice(0, question)
		this.query = parse(question < 0 ? "" : this.originalUrl.slice(question + 1))
		this.handleError = async (value) => {
			const error = value instanceof Error ? value : new Error(String(value))
			this.app.emit("error", error, this)
			this.clearResponseHeaders()
			const s3Error =
				error instanceof S3Error ? error : S3Error.fromError(error)
			this.type = "application/xml"
			this.status = s3Error.status
			this.body = s3Error.toXML()
		}
	}
	get store() {
		return this.app.store
	}
	get logger() {
		return this.app.logger
	}
	get method() {
		return this.req.method ?? "GET"
	}
	get host() {
		return this.get("host")
	}
	get hostname() {
		return this.host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
	}
	get protocol() {
		return this.req.socket instanceof TLSSocket && this.req.socket.encrypted
			? "https"
			: "http"
	}
	get ip() {
		return this.req.socket.remoteAddress ?? ""
	}
	get url() {
		return (
			this.path +
			(this.originalUrl.includes("?")
				? this.originalUrl.slice(this.originalUrl.indexOf("?"))
				: "")
		)
	}
	get href() {
		return `${this.protocol}://${this.host}${this.url}`
	}
	get body() {
		return this.responseBody
	}
	set body(value: ResponseBody) {
		this.responseBody = value
		if (!this.explicitStatus) this.responseStatus = value === null ? 204 : 200
	}
	get status() {
		return this.responseStatus
	}
	set status(value: number) {
		this.responseStatus = value
		this.explicitStatus = true
	}
	set length(value: number) {
		this.set("Content-Length", String(value))
	}
	set etag(value: string) {
		this.set("ETag", /^W\/"|^"/.test(value) ? value : `"${value}"`)
	}
	set type(value: string) {
		if (!value) this.remove("Content-Type")
		else
			this.set(
				"Content-Type",
				value.startsWith("text/") && !value.includes("charset=")
					? `${value}; charset=utf-8`
					: value,
			)
	}
	get(name: string): string {
		const value = this.headers[name.toLowerCase()]
		return Array.isArray(value) ? value.join(", ") : (value ?? "")
	}
	is(type: string): boolean {
		return this.get("content-type").split(";")[0]?.trim() === type
	}
	set(name: string | Record<string, string>, value?: string): void {
		if (typeof name === "string") this.responseHeaders.set(name, value ?? "")
		else
			for (const [key, entry] of Object.entries(name))
				this.responseHeaders.set(key, entry)
	}
	remove(name: string): void {
		this.responseHeaders.delete(name)
	}
	getResponseHeader(name: string): string {
		return this.responseHeaders.get(name) ?? ""
	}
	clearResponseHeaders(): void {
		for (const name of this.responseHeaders.keys()) {
			if (!/^access-control-|vary|x-amz-/i.test(name)) this.remove(name)
		}
	}
	redirect(url: string): void {
		this.set("Location", url)
		this.status = 302
		this.body = ""
	}

	/** Serialize only after controllers and error handlers finish; object bodies remain streamed. */
	toResponse(): Response {
		let body = this.body
		if (
			body !== null &&
			typeof body === "object" &&
			(Object.getPrototypeOf(body) === Object.prototype ||
				Object.getPrototypeOf(body) === null)
		) {
			this.type = "application/xml"
			body = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlBuilder.parse(body)
		}
		if (body === null && this.status === 404) {
			body = "Not Found"
			this.type = "text/plain"
		}
		if (typeof body === "string" || Buffer.isBuffer(body)) {
			if (!this.responseHeaders.has("Content-Type") && body.length)
				this.type = Buffer.isBuffer(body)
					? "application/octet-stream"
					: "text/plain"
			this.length = Buffer.byteLength(body)
		}
		if ([204, 205, 304].includes(this.status)) {
			if (body instanceof Readable) body.destroy()
			body = null
			this.remove("Content-Type")
			this.remove("Content-Length")
		}
		if (this.method === "HEAD") {
			if (body instanceof Readable) body.destroy()
			body = null
		}
		const payload =
			body instanceof Readable
				? byteStream(body)
				: Buffer.isBuffer(body)
					? new Uint8Array(body)
					: typeof body === "string" && body.length > 0
						? new TextEncoder().encode(body)
						: null
		return new Response(payload, {
			status: this.status,
			headers: this.responseHeaders,
		})
	}
}

/** Bridge Node's stream typings to Fetch while preserving backpressure and cancellation. */
function byteStream(body: Readable): ReadableStream<Uint8Array> {
	const reader = Readable.toWeb(body, {
		strategy: {
			highWaterMark: body.readableHighWaterMark,
			size(chunk: unknown) {
				return chunk instanceof Uint8Array ? chunk.byteLength : 1
			},
		},
	}).getReader()
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const result = await reader.read()
			if (result.done) controller.close()
			else if (result.value instanceof Uint8Array)
				controller.enqueue(result.value)
			else controller.error(new Error("Expected a byte stream"))
		},
		cancel(reason: unknown) {
			return reader.cancel(reason)
		},
	})
}
