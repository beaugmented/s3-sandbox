import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { createServerAndClient, required } from "../public/helpers.ts"

afterEach(() => vi.restoreAllMocks())

describe("Object operation storage errors", () => {
	it.each(["delete", "tag", "part", "complete", "copy"] as const)(
		"propagates %s failures without publishing a success event",
		async (operation) => {
			const { s3rver, s3Client } = await createServerAndClient({
				configureBuckets: [{ name: "bucket-a" }],
			})
			const source = { Bucket: "bucket-a", Key: "source" }
			await s3Client.putObject({ ...source, Body: "source bytes" })
			const target = { Bucket: "bucket-a", Key: "target" }
			const upload = await s3Client.createMultipartUpload(target)
			const parameters = { ...target, UploadId: required(upload.UploadId) }
			const event = vi.fn()
			s3rver.on("event", event)
			const failure = new Error("private disk failure")
			let pending: Promise<unknown>
			switch (operation) {
				case "delete":
					vi.spyOn(s3rver.store, "deleteObject").mockRejectedValue(failure)
					pending = s3Client.deleteObject(source)
					break
				case "tag":
					vi.spyOn(s3rver.store, "putSubresource").mockRejectedValue(failure)
					pending = s3Client.putObjectTagging({
						...source,
						Tagging: { TagSet: [{ Key: "name", Value: "value" }] },
					})
					break
				case "part":
					vi.spyOn(s3rver.store, "putPart").mockRejectedValue(failure)
					pending = s3Client.uploadPart({
						...parameters,
						PartNumber: 1,
						Body: "part bytes",
					})
					break
				case "complete":
					vi.spyOn(s3rver.store, "putObjectMultipart").mockRejectedValue(
						failure,
					)
					pending = s3Client.completeMultipartUpload({
						...parameters,
						MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"digest"' }] },
					})
					break
				case "copy":
					// Consume the opened source before injecting a write failure.
					vi.spyOn(s3rver.store, "putPart").mockImplementation(
						async (_bucket, _uploadId, _number, content) => {
							if (content instanceof Readable) {
								content.resume()
								await finished(content, { cleanup: true })
							}
							throw failure
						},
					)
					pending = s3Client.uploadPartCopy({
						...parameters,
						PartNumber: 1,
						CopySource: "/bucket-a/source",
					})
					break
			}
			await expect(pending).rejects.toMatchObject({
				name: "InternalError",
				message: "We encountered an internal error. Please try again.",
				$metadata: { httpStatusCode: 500 },
			})
			expect(event).not.toHaveBeenCalled()
		},
	)
})
