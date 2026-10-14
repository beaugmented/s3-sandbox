import { describe, expect, it } from "vite-plus/test"
import http from "node:http"
import { once } from "node:events"
import { Readable } from "node:stream"
import request from "../public/http.ts"

describe("HTTP upload fixture cleanup", () => {
	it("rejects when an upload producer fails", async () => {
		const source = new Readable({
			read() {
				this.destroy(new Error("upload fixture failed"))
			},
		})
		const server = http.createServer((incoming) => incoming.resume())
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		try {
			const address = server.address()
			if (!address || typeof address === "string")
				throw new Error("Expected a TCP address")
			await expect(
				request.post(`http://127.0.0.1:${address.port}/`, { body: source }),
			).rejects.toThrow("upload fixture failed")
		} finally {
			source.destroy()
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		}
	})

	it("closes the upload producer when the server disconnects", async () => {
		const source = new Readable({
			read() {
				this.push(Buffer.alloc(65536))
			},
		})
		const closed = new Promise<void>((resolve) => source.once("close", resolve))
		const server = http.createServer((incoming) => {
			incoming.once("data", () => incoming.socket.destroy())
		})
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		try {
			const address = server.address()
			if (!address || typeof address === "string")
				throw new Error("Expected a TCP address")
			await expect(
				request.post(`http://127.0.0.1:${address.port}/`, { body: source }),
			).rejects.toThrow()
			await closed
			expect(source.destroyed).toBe(true)
		} finally {
			source.destroy()
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		}
	})
})
