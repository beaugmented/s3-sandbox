import { beforeEach, describe, expect, it } from "vite-plus/test"
import {
	createServerAndClient,
	errorResponse,
	readBody,
	required,
	type TestS3Client,
} from "./helpers.ts"
import request from "./http.ts"

describe("Object range boundaries", () => {
	let client: TestS3Client
	const object = { Bucket: "bucket-a", Key: "object" }
	beforeEach(async () => {
		const { s3Client } = await createServerAndClient({
			configureBuckets: [{ name: object.Bucket }],
		})
		client = s3Client
		await client.putObject({ ...object, Body: "0123456789" })
	})

	it.each([
		{ range: "bytes=0-0", bytes: "0", span: "0-0" },
		{ range: "bytes=9-9", bytes: "9", span: "9-9" },
		{ range: "bytes=3-", bytes: "3456789", span: "3-9" },
		{ range: "bytes=0-100", bytes: "0123456789", span: "0-9" },
		{ range: "bytes=000-000", bytes: "0", span: "0-0" },
		{ range: "bytes=-1", bytes: "9", span: "9-9" },
		{ range: "bytes=-3", bytes: "789", span: "7-9" },
		{ range: "bytes=-10", bytes: "0123456789", span: "0-9" },
		{ range: "bytes=-100", bytes: "0123456789", span: "0-9" },
		{ range: `bytes=0-${"9".repeat(400)}`, bytes: "0123456789", span: "0-9" },
		{ range: `bytes=-${"9".repeat(400)}`, bytes: "0123456789", span: "0-9" },
	])(
		"returns exact bytes and headers for $range",
		async ({ range, bytes, span }) => {
			const response = await request("bucket-a/object", {
				baseUrl: client.endpoint.href,
				headers: { range, connection: "close" },
				encoding: null,
			})
			expect(response.statusCode).toBe(206)
			expect(response.body).toEqual(Buffer.from(bytes))
			expect(response.headers["content-range"]).toBe(`bytes ${span}/10`)
			expect(response.headers["content-length"]).toBe(String(bytes.length))
			expect(response.headers["accept-ranges"]).toBe("bytes")
		},
	)
	it.each([
		"bytes=3-2",
		"bytes=10-",
		"bytes=100-200",
		"bytes=-0",
		`bytes=${"9".repeat(400)}-`,
	])("rejects unsatisfiable %s with an S3 range error", async (range) => {
		const response = await request("bucket-a/object", {
			baseUrl: client.endpoint.href,
			headers: { range, connection: "close" },
		}).catch(errorResponse)
		expect(response.statusCode).toBe(416)
		expect(String(response.body)).toContain("<Code>InvalidRange</Code>")
		expect(String(response.body)).toContain(
			"<ActualObjectSize>10</ActualObjectSize>",
		)
	})
	it.each([
		"bytes=",
		"bytes=-",
		"bytes=abc-def",
		"bytes=0.5-1",
		"bytes=0-1,3-4",
		"items=0-1",
	])("ignores malformed or unsupported range %s", async (range) => {
		const response = await request("bucket-a/object", {
			baseUrl: client.endpoint.href,
			headers: { range, connection: "close" },
		})
		expect(response.statusCode).toBe(200)
		expect(response.body).toBe("0123456789")
		expect(response.headers["content-length"]).toBe("10")
		expect(response.headers["content-range"]).toBeUndefined()
	})
	it("returns an empty object with no range as a normal zero-byte response", async () => {
		await client.putObject({ ...object, Body: "" })
		const response = await request("bucket-a/object", {
			baseUrl: client.endpoint.href,
			headers: { connection: "close" },
		})
		expect(response.statusCode).toBe(200)
		expect(response.body).toBe("")
		expect(response.headers["content-length"]).toBe("0")
		expect(response.headers["content-range"]).toBeUndefined()
	})
	it.each(["bytes=0-0", "bytes=0-", "bytes=-1"])(
		"rejects %s against an empty object",
		async (range) => {
			await client.putObject({ ...object, Body: "" })
			const response = await request("bucket-a/object", {
				baseUrl: client.endpoint.href,
				headers: { range, connection: "close" },
			}).catch(errorResponse)
			expect(response.statusCode).toBe(416)
			expect(String(response.body)).toContain("<Code>InvalidRange</Code>")
			expect(String(response.body)).toContain(
				"<ActualObjectSize>0</ActualObjectSize>",
			)
		},
	)
	it("retains the partial HEAD response without returning object bytes", async () => {
		const response = await request("bucket-a/object", {
			baseUrl: client.endpoint.href,
			method: "HEAD",
			headers: { range: "bytes=0-0", connection: "close" },
		})
		expect(response.statusCode).toBe(206)
		expect(response.body).toBe("")
		expect(response.headers["content-length"]).toBe("1")
		expect(response.headers["content-range"]).toBe("bytes 0-0/10")
	})
	it("copies just the first byte into a multipart upload", async () => {
		const target = { Bucket: "bucket-a", Key: "copy" }
		const upload = await client.createMultipartUpload(target)
		const parameters = { ...target, UploadId: required(upload.UploadId) }
		const part = await client.uploadPartCopy({
			...parameters,
			PartNumber: 1,
			CopySource: "/bucket-a/object",
			CopySourceRange: "bytes=0-0",
		})
		await client.completeMultipartUpload({
			...parameters,
			MultipartUpload: {
				Parts: [{ PartNumber: 1, ETag: required(part.CopyPartResult?.ETag) }],
			},
		})
		const copied = await client.getObject(target)
		expect(copied.ContentLength).toBe(1)
		expect(await readBody(copied.Body)).toEqual(Buffer.from("0"))
	})
})
