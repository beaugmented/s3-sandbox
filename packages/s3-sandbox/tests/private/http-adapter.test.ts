import { describe, expect, it } from "vite-plus/test"
import http from "node:http"
import { Socket } from "node:net"
import { Readable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { signRawRequest } from "../public/signing.ts"
import { Hono } from "hono"
import type { HttpBindings } from "@hono/node-server"
import { createHonoListener } from "../public/hono.ts"
import S3Sandbox from "../../src/s3rver.ts"
import { S3HttpContext } from "../../src/http-context.ts"
import { createServerAndClient } from "../public/helpers.ts"

async function wire(
	port: number,
	path: string,
	method: string,
	body = "",
	sign = true,
) {
	const headers = {
		host: `localhost:${port}`,
		"Content-Length": Buffer.byteLength(body),
	}
	const signed = await signRawRequest({
		hostname: "localhost",
		protocol: "http:",
		port,
		method,
		path,
		headers: { ...headers },
		body,
	})
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = http.request(
			{
				hostname: "localhost",
				port,
				method,
				path,
				headers: sign ? signed.headers : headers,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => chunks.push(chunk))
				res.on("error", reject)
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				)
			},
		)
		req.on("error", reject)
		req.end(body)
	})
}

describe("Hono Node adapter", () => {
	it("leaves global Fetch constructors unchanged", () => {
		const constructors = [globalThis.Request, globalThis.Response]
		new S3Sandbox({ silent: true }).callback()
		expect([globalThis.Request, globalThis.Response]).toEqual(constructors)
	})
	it.each(
		["folder/../key", "double//key", "unicode-%E2%98%83"].flatMap((key) => [
			{ key, mountPath: "" },
			{ key, mountPath: "/basepath" },
		]),
	)(
		"preserves raw signed path $key with mount $mountPath through uploads and downloads",
		async ({ key, mountPath }) => {
			const { s3rver } = await createServerAndClient({
				configureBuckets: [{ name: "bucket-a" }],
			})
			if (mountPath) {
				const app = new Hono<{ Bindings: HttpBindings }>()
				app.use(mountPath + "/*", s3rver.getHonoMiddleware(mountPath))
				s3rver.httpServer?.removeAllListeners("request")
				s3rver.httpServer?.on("request", createHonoListener(app))
			}
			const address = s3rver.httpServer?.address()
			if (!address || typeof address === "string")
				throw new Error("Expected a TCP address")
			if (mountPath) {
				expect((await wire(address.port, mountPath, "GET")).status).toBe(200)
				expect(
					(await wire(address.port, `${mountPath}?ignored=1`, "GET")).status,
				).toBe(200)
			}
			expect(
				(
					await wire(
						address.port,
						`${mountPath}/bucket-a/${key}`,
						"PUT",
						"raw path",
					)
				).status,
			).toBe(200)
			expect(
				await wire(address.port, `${mountPath}/bucket-a/${key}`, "GET"),
			).toEqual({
				status: 200,
				body: "raw path",
			})
			expect(
				await s3rver.store.existsObject("bucket-a", decodeURIComponent(key)),
			).toBe(true)
		},
	)
	it("preserves escaped slashes in anonymous request paths", async () => {
		const { s3rver } = await createServerAndClient({
			configureBuckets: [{ name: "bucket-a" }],
		})
		const address = s3rver.httpServer?.address()
		if (!address || typeof address === "string")
			throw new Error("Expected a TCP address")
		expect(
			(
				await wire(
					address.port,
					"/bucket-a/literal%2F-key",
					"PUT",
					"escaped slash",
					false,
				)
			).status,
		).toBe(200)
		expect(
			await wire(address.port, "/bucket-a/literal%2F-key", "GET", "", false),
		).toEqual({ status: 200, body: "escaped slash" })
		expect(await s3rver.store.existsObject("bucket-a", "literal/-key")).toBe(
			true,
		)
	})
	it("streams byte chunks created in another JavaScript realm", async () => {
		const chunk: unknown = runInNewContext(
			"new Uint8Array([104, 101, 108, 108, 111])",
		)
		expect(chunk instanceof Uint8Array).toBe(false)
		const ctx = new S3HttpContext(
			new S3Sandbox({ silent: true }),
			new http.IncomingMessage(new Socket()),
		)
		ctx.body = Readable.from([chunk, Buffer.from(" world")])
		expect(await ctx.toResponse().text()).toBe("hello world")
	})
	it("applies byte backpressure and cancellation to chunks from another realm", async () => {
		const chunk: unknown = runInNewContext("new Uint8Array(64)")
		let chunks = 0
		const source = new Readable({
			objectMode: true,
			highWaterMark: 64,
			read() {
				chunks++
				this.push(chunk)
			},
		})
		const closed = new Promise<void>((resolve) => source.once("close", resolve))
		const ctx = new S3HttpContext(
			new S3Sandbox({ silent: true }),
			new http.IncomingMessage(new Socket()),
		)
		ctx.body = source
		const reader = ctx.toResponse().body?.getReader()
		if (!reader) throw new Error("Expected a response stream")
		try {
			await setImmediate()
			// One queued byte chunk and one pulled chunk beyond Node's object buffer.
			expect(chunks).toBeLessThanOrEqual(66)
			const result = await reader.read()
			expect(result.value?.byteLength).toBe(64)
		} finally {
			await reader.cancel()
			await closed
		}
		expect(source.destroyed).toBe(true)
	})
	it.each(["text", new Uint16Array([1, 2]), new DataView(new ArrayBuffer(2))])(
		"rejects non-byte stream chunks (%s)",
		async (chunk) => {
			const ctx = new S3HttpContext(
				new S3Sandbox({ silent: true }),
				new http.IncomingMessage(new Socket()),
			)
			ctx.body = Readable.from([chunk])
			await expect(ctx.toResponse().text()).rejects.toThrow(
				"Expected a byte stream",
			)
		},
	)
	it("cancels the source stream when a Fetch consumer disconnects", async () => {
		let chunks = 0
		const source = new Readable({
			read() {
				chunks++
				this.push(Buffer.alloc(65536))
			},
		})
		const closed = new Promise<void>((resolve) => source.once("close", resolve))
		const ctx = new S3HttpContext(
			new S3Sandbox({ silent: true }),
			new http.IncomingMessage(new Socket()),
		)
		ctx.body = source
		const reader = ctx.toResponse().body?.getReader()
		if (!reader) throw new Error("Expected a response stream")
		await setImmediate()
		expect(chunks).toBeLessThan(10)
		await reader.read()
		await reader.cancel()
		await closed
		expect(source.destroyed).toBe(true)
	})
})
