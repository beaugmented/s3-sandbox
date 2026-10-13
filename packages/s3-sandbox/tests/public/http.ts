import http from "node:http"
import https from "node:https"
import type { Readable } from "node:stream"

export type HttpResponse = {
	statusCode: number
	headers: http.IncomingHttpHeaders
	body: string | Buffer
}
type Options = {
	baseUrl?: string
	method?: string
	headers?: http.OutgoingHttpHeaders
	qs?: Record<string, string | number> | URLSearchParams
	body?: string | Buffer | Readable
	encoding?: null | string
	followRedirect?: boolean
}

export class HttpError extends Error {
	response: HttpResponse
	constructor(response: HttpResponse) {
		super(`HTTP ${response.statusCode}: ${String(response.body)}`)
		this.response = response
	}
}

/** Small raw HTTP helper: preserves malformed signatures and exact request bytes. */
async function request(
	uri: string | URL,
	options: Options = {},
	redirects = 0,
): Promise<HttpResponse> {
	const url = new URL(uri, options.baseUrl)
	if (options.qs) {
		const entries =
			options.qs instanceof URLSearchParams
				? options.qs.entries()
				: Object.entries(options.qs)
		for (const [name, value] of entries)
			url.searchParams.set(name, String(value))
	}
	const transport = url.protocol === "https:" ? https : http
	const response = await new Promise<HttpResponse>((resolve, reject) => {
		const req = transport.request(
			url,
			{ method: options.method ?? "GET", headers: options.headers },
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
				res.on("error", reject)
				res.on("end", () => {
					const bytes = Buffer.concat(chunks)
					resolve({
						statusCode: res.statusCode ?? 0,
						headers: res.headers,
						body: options.encoding === null ? bytes : bytes.toString("utf8"),
					})
				})
			},
		)
		req.on("error", reject)
		if (
			options.body &&
			typeof options.body !== "string" &&
			!Buffer.isBuffer(options.body)
		)
			options.body.pipe(req)
		else req.end(options.body)
	})
	const follows =
		options.followRedirect !== false &&
		["GET", "HEAD"].includes(options.method ?? "GET")
	if (
		response.headers.location &&
		[301, 302, 303, 307, 308].includes(response.statusCode) &&
		follows
	) {
		if (redirects >= 10) throw new Error("Too many redirects")
		const { body: _body, qs: _qs, ...redirectOptions } = options
		return request(
			new URL(response.headers.location, url),
			{ ...redirectOptions, method: "GET" },
			redirects + 1,
		)
	}
	if (response.statusCode >= 300) throw new HttpError(response)
	return response
}

export default Object.assign(request, {
	post: (uri: string | URL, options: Options = {}) =>
		request(uri, { ...options, method: "POST" }),
	put: (uri: string | URL, options: Options = {}) =>
		request(uri, { ...options, method: "PUT" }),
})
