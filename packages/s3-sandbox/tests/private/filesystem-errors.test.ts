import fs from "node:fs"
import { finished } from "node:stream/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import S3Object from "../../src/models/object.ts"
import FilesystemStore from "../../src/stores/filesystem.ts"
import { readBody, required } from "../public/helpers.ts"

const createReadStream = fs.createReadStream

describe("Filesystem failure boundaries", () => {
	let directory: string
	let store: FilesystemStore
	let streams: fs.ReadStream[]
	const bucket = "bucket-a"
	const key = "object"
	beforeEach(async () => {
		streams = []
		directory = await fs.promises.mkdtemp(
			path.join(tmpdir(), "s3-store-errors-"),
		)
		store = new FilesystemStore(directory)
		await store.putObject(
			new S3Object(bucket, key, Buffer.from("stored bytes"), {
				"content-type": "text/plain",
			}),
		)
		vi.spyOn(fs, "createReadStream").mockImplementation((filePath, options) => {
			const stream = createReadStream(filePath, options)
			streams.push(stream)
			return stream
		})
		syncBuiltinESMExports()
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		syncBuiltinESMExports()
		await Promise.all(
			streams.map(async (stream) => {
				if (!stream.destroyed) stream.destroy()
				await finished(stream, { cleanup: true }).catch(() => {})
			}),
		)
		await fs.promises.rm(directory, { recursive: true, force: true })
	})

	it("reads objects without metadata sidecars and recreates a missing digest", async () => {
		const expected = await store.getMetadata(bucket, key)
		await Promise.all([
			fs.promises.unlink(store.getResourcePath(bucket, key, "metadata.json")),
			fs.promises.unlink(store.getResourcePath(bucket, key, "object.md5")),
		])
		const object = required(await store.getObject(bucket, key))
		expect(object.size).toBe(12)
		expect(object.metadata.etag).toBe(expected.etag)
		expect(object.metadata["content-type"]).toBe("binary/octet-stream")
		expect(await readBody(object.content)).toEqual(Buffer.from("stored bytes"))
		expect(
			await fs.promises.readFile(
				store.getResourcePath(bucket, key, "object.md5"),
				"utf8",
			),
		).toBe(JSON.parse(expected.etag))
	})
	it("rejects malformed stored metadata instead of treating it as missing", async () => {
		await fs.promises.writeFile(
			store.getResourcePath(bucket, key, "metadata.json"),
			'{"content-type":{"nested":true}}',
		)
		await expect(store.getMetadata(bucket, key)).rejects.toMatchObject({
			name: "ZodError",
		})
	})
	it.each(["metadata", "digest"] as const)(
		"propagates permission errors reading the %s sidecar",
		async (sidecar) => {
			const failure = Object.assign(new Error("read denied"), {
				code: "EACCES",
			})
			const read = vi.spyOn(fs.promises, "readFile")
			if (sidecar === "digest") read.mockResolvedValueOnce(Buffer.from("{}"))
			read.mockRejectedValueOnce(failure)
			await expect(store.getMetadata(bucket, key)).rejects.toBe(failure)
		},
	)
	it("propagates errors persisting a recreated digest", async () => {
		await fs.promises.unlink(store.getResourcePath(bucket, key, "object.md5"))
		const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" })
		vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(failure)
		await expect(store.getMetadata(bucket, key)).rejects.toBe(failure)
	})
	it.each(["exists", "bucket", "object", "listing"] as const)(
		"propagates stat errors through %s lookup",
		async (operation) => {
			const failure = Object.assign(new Error("stat denied"), {
				code: "EACCES",
			})
			vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(failure)
			const pending =
				operation === "exists"
					? store.existsObject(bucket, key)
					: operation === "bucket"
						? store.getBucket(bucket)
						: operation === "object"
							? store.getObject(bucket, key)
							: store.listObjects(bucket, {})
			await expect(pending).rejects.toBe(failure)
		},
	)
	it("omits objects deleted after enumeration while retaining the remaining listing", async () => {
		await store.putObject(
			new S3Object(bucket, "remaining", Buffer.from("kept"), {}),
		)
		const metadata = store.getMetadata.bind(store)
		vi.spyOn(store, "getMetadata").mockImplementation(
			async (name, objectKey) => {
				if (objectKey === key) {
					await fs.promises.unlink(
						store.getResourcePath(name, objectKey, "object"),
					)
				}
				return metadata(name, objectKey)
			},
		)
		const result = await store.listObjects(bucket, {})
		expect(result.objects.map((object) => object.key)).toEqual(["remaining"])
		expect(result.isTruncated).toBe(false)
	})
	it("returns no object when its data disappears after metadata is read", async () => {
		const metadata = store.getMetadata.bind(store)
		vi.spyOn(store, "getMetadata").mockImplementationOnce(
			async (name, objectKey) => {
				const result = await metadata(name, objectKey)
				await fs.promises.unlink(
					store.getResourcePath(name, objectKey, "object"),
				)
				return result
			},
		)
		await expect(store.getObject(bucket, key)).resolves.toBeNull()
	})
	it("propagates errors opening an object data stream", async () => {
		const failure = Object.assign(new Error("open denied"), { code: "EACCES" })
		vi.spyOn(fs, "createReadStream").mockImplementationOnce((filePath) => {
			const stream = createReadStream(filePath, {
				fs: {
					open: (
						_file: fs.PathLike,
						_flags: string | number,
						_mode: fs.Mode,
						callback: (error: NodeJS.ErrnoException | null, fd: number) => void,
					) => callback(failure, 0),
					read: fs.read,
					close: fs.close,
				},
			})
			streams.push(stream)
			return stream
		})
		syncBuiltinESMExports()
		await expect(store.getObject(bucket, key)).rejects.toBe(failure)
	})
	it.each(["object", "subresource"] as const)(
		"propagates unlink errors deleting an %s",
		async (resource) => {
			const failure = Object.assign(new Error("unlink denied"), {
				code: "EACCES",
			})
			vi.spyOn(fs.promises, "unlink").mockRejectedValue(failure)
			await expect(
				resource === "object"
					? store.deleteObject(bucket, key)
					: store.deleteSubresource(bucket, key, "tagging"),
			).rejects.toBe(failure)
			expect(await store.existsObject(bucket, key)).toBe(true)
		},
	)
	it("propagates read errors fetching a bucket configuration", async () => {
		const failure = Object.assign(new Error("read denied"), { code: "EACCES" })
		vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(failure)
		await expect(store.getSubresource(bucket, undefined, "cors")).rejects.toBe(
			failure,
		)
	})
	it("preserves a direct range ending at zero", async () => {
		const object = required(await store.getObject(bucket, key, { end: 0 }))
		expect(object.range).toEqual({ start: 0, end: 0 })
		expect(await readBody(object.content)).toEqual(Buffer.from("s"))
	})
	it.each([
		{ start: -1 },
		{ start: NaN },
		{ start: 0.5 },
		{ end: -1 },
		{ end: NaN },
		{ suffixLength: 0 },
		{ suffixLength: -1 },
		{ suffixLength: Infinity },
	])("does not open a stream for invalid range options %j", async (options) => {
		const object = required(await store.getObject(bucket, key, options))
		expect(object.content).toBeNull()
		expect(object.range).toBeDefined()
		expect(streams).toEqual([])
	})
})
