import { describe, expect, it, vi } from "vite-plus/test"
import http from "node:http"
import { once } from "node:events"
import { createServerAndClient } from "../public/helpers.ts"
import request from "../public/http.ts"

const boundary = "upload-boundary"
const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\nobject\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\n\r\n`

describe("Multipart request cleanup", () => {
	it("closes the file writer when an upload request disconnects", async () => {
		const { s3rver, s3Client } = await createServerAndClient({
			configureBuckets: [{ name: "bucket-a" }],
		})
		const started = Promise.withResolvers<void>()
		const original = s3rver.store.putObject.bind(s3rver.store)
		const writer = vi
			.spyOn(s3rver.store, "putObject")
			.mockImplementation((object) => {
				started.resolve()
				return original(object)
			})
		const failed = once(s3rver, "error")
		const upload = http.request(new URL("bucket-a", s3Client.endpoint), {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		})
		upload.on("error", () => {
			/* A disconnected client receives no response. */
		})
		upload.write(prefix)
		upload.write(Buffer.alloc(256 * 1024))
		await started.promise
		upload.destroy()
		const errors: readonly unknown[] = await failed
		expect(errors[0]).toBeInstanceOf(Error)
		const result = writer.mock.results[0]
		if (result?.type !== "return") throw new Error("Expected a file writer")
		await expect(result.value).rejects.toThrow()
	})
	it("rejects an incomplete file without an unhandled stream error or upload event", async () => {
		const { s3rver, s3Client } = await createServerAndClient({
			configureBuckets: [{ name: "bucket-a" }],
		})
		const event = vi.fn()
		s3rver.on("event", event)
		await expect(
			request.post("bucket-a", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					"content-type": `multipart/form-data; boundary=${boundary}`,
				},
				body: prefix + "incomplete file",
			}),
		).rejects.toThrow()
		expect(event).not.toHaveBeenCalled()
	})
})
