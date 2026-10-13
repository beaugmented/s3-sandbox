import {
	CopyObjectCommand,
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test"
import S3Sandbox from "../../src/s3rver.ts"

describe("Public runtime contract", () => {
	let directory: string
	let server: S3Sandbox
	let client: S3Client | undefined
	beforeEach(() => {
		directory = mkdtempSync(path.join(tmpdir(), "s3-sandbox-runtime-"))
		server = new S3Sandbox({
			directory,
			port: 0,
			address: "127.0.0.1",
			silent: true,
		})
	})
	afterEach(async () => {
		client?.destroy()
		if (server.httpServer?.listening) await server.close()
		rmSync(directory, { recursive: true, force: true })
	})

	async function sdk() {
		const { port } = await server.run()
		client = new S3Client({
			endpoint: `http://127.0.0.1:${port}`,
			region: "us-east-1",
			forcePathStyle: true,
			credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
		})
		return client
	}

	it("supports modern SDK CRUD and byte ranges", async () => {
		const s3 = await sdk()
		await s3.send(new CreateBucketCommand({ Bucket: "sdk-bucket" }))
		await s3.send(
			new PutObjectCommand({
				Bucket: "sdk-bucket",
				Key: "a/b.txt",
				Body: "hello world",
				Metadata: { sample: "yes" },
			}),
		)
		const result = await s3.send(
			new GetObjectCommand({
				Bucket: "sdk-bucket",
				Key: "a/b.txt",
				Range: "bytes=0-4",
			}),
		)
		expect(await result.Body!.transformToString()).toBe("hello")
		expect(result.Metadata).toEqual({ sample: "yes" })
		expect(result.ContentRange).toBe("bytes 0-4/11")
		await s3.send(
			new CopyObjectCommand({
				Bucket: "sdk-bucket",
				Key: "copy.txt",
				CopySource: "sdk-bucket/a/b.txt",
			}),
		)
		expect(
			(
				await s3.send(new ListObjectsV2Command({ Bucket: "sdk-bucket" }))
			).Contents?.map((object) => object.Key),
		).toEqual(["a/b.txt", "copy.txt"])
		await s3.send(
			new DeleteObjectCommand({ Bucket: "sdk-bucket", Key: "copy.txt" }),
		)
	})

	it("accepts modern presigned GET and PUT URLs", async () => {
		const s3 = await sdk()
		await s3.send(new CreateBucketCommand({ Bucket: "signed-bucket" }))
		const put = await getSignedUrl(
			s3,
			new PutObjectCommand({ Bucket: "signed-bucket", Key: "signed.txt" }),
			{ expiresIn: 60 },
		)
		expect(
			(await fetch(put, { method: "PUT", body: "signed body" })).status,
		).toBe(200)
		const get = await getSignedUrl(
			s3,
			new GetObjectCommand({ Bucket: "signed-bucket", Key: "signed.txt" }),
			{ expiresIn: 60 },
		)
		expect(await (await fetch(get)).text()).toBe("signed body")
	})

	it("preserves stored objects across server restarts", async () => {
		const s3 = await sdk()
		await s3.send(new CreateBucketCommand({ Bucket: "persistent-bucket" }))
		await s3.send(
			new PutObjectCommand({
				Bucket: "persistent-bucket",
				Key: "saved.txt",
				Body: "retained",
			}),
		)
		await server.close()
		server = new S3Sandbox({
			directory,
			port: 0,
			address: "127.0.0.1",
			silent: true,
		})
		const restarted = await sdk()
		const object = await restarted.send(
			new GetObjectCommand({ Bucket: "persistent-bucket", Key: "saved.txt" }),
		)
		expect(await object.Body!.transformToString()).toBe("retained")
	})

	it("preserves callback and middleware entrypoints", async () => {
		await new Promise<void>((resolve, reject) => {
			expect(
				server.run((error, address) => {
					if (error) reject(error)
					else {
						expect(address!.port).toBeGreaterThan(0)
						resolve()
					}
				}),
			).toBe(server)
		})
		expect(typeof server.callback()).toBe("function")
		expect(typeof server.getMiddleware()).toBe("function")
		await new Promise<void>((resolve, reject) => {
			expect(server.close((error) => (error ? reject(error) : resolve()))).toBe(
				server,
			)
		})
		await expect(server.close()).rejects.toThrow("Not running")
	})

	it("rejects an occupied port and can retry after a startup failure", async () => {
		const blocker = createServer()
		await new Promise<void>((resolve) =>
			blocker.listen(0, "127.0.0.1", resolve),
		)
		const address = blocker.address()
		if (!address || typeof address === "string")
			throw new Error("Expected TCP listener")
		server = new S3Sandbox({
			directory,
			address: "127.0.0.1",
			port: address.port,
			silent: true,
		})
		try {
			await expect(server.run()).rejects.toMatchObject({ code: "EADDRINUSE" })
		} finally {
			await new Promise<void>((resolve, reject) =>
				blocker.close((error) => (error ? reject(error) : resolve())),
			)
		}
		expect((await server.run()).port).toBe(address.port)
		await expect(server.run()).rejects.toThrow("Already running")
	})
})
