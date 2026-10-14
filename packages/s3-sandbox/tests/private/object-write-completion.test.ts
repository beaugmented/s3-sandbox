import crypto from "node:crypto"
import fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import S3Object from "../../src/models/object.ts"
import FilesystemStore from "../../src/stores/filesystem.ts"
import { createServerAndClient } from "../public/helpers.ts"

afterEach(() => {
	vi.restoreAllMocks()
	syncBuiltinESMExports()
})

// Hold actual file writes, including empty-body finalization, until released.
// This makes premature completion observable without relying on disk speed.
function holdObjectWrites() {
	const started = Promise.withResolvers<void>()
	const pending: ((error?: Error) => void)[] = []
	const closed: Promise<void>[] = []
	let released = false
	function hold(operation: (error?: Error) => void) {
		if (released) operation()
		else {
			pending.push(operation)
			started.resolve()
		}
	}
	const createWriteStream = fs.createWriteStream
	vi.spyOn(fs, "createWriteStream").mockImplementation((filePath, options) => {
		const stream = createWriteStream(filePath, options)
		if (!String(filePath).endsWith("._S3rver_object")) return stream
		const close = Promise.withResolvers<void>()
		stream.once("close", close.resolve)
		closed.push(close.promise)
		// oxlint-disable eslint/no-underscore-dangle -- Gate Node's writable hooks while retaining real file streams.
		const write = stream._write.bind(stream)
		stream._write = (chunk: unknown, encoding, callback) => {
			if (!Buffer.isBuffer(chunk)) throw new TypeError("Expected bytes")
			hold((error) =>
				error ? callback(error) : write(chunk, encoding, callback),
			)
		}
		const writev = stream._writev?.bind(stream)
		if (writev)
			stream._writev = (chunks, callback) => {
				hold((error) => (error ? callback(error) : writev(chunks, callback)))
			}
		const final = stream._final?.bind(stream)
		stream._final = (callback) => {
			hold((error) => {
				if (error) callback(error)
				else if (final) final(callback)
				else callback()
			})
		}
		// oxlint-enable eslint/no-underscore-dangle
		return stream
	})
	syncBuiltinESMExports()
	return {
		started: started.promise,
		waitForClose: () => Promise.all(closed),
		release(error?: Error) {
			released = true
			for (const operation of pending.splice(0)) operation(error)
		},
	}
}

describe("Object write completion", () => {
	it.each(["buffer", "stream"] as const)(
		"waits for delayed %s writes and propagates disk errors",
		async (input) => {
			const directory = await mkdtemp(path.join(tmpdir(), "s3-write-error-"))
			const gate = holdObjectWrites()
			const store = new FilesystemStore(directory)
			const metadata = vi.spyOn(store, "putMetadata")
			const bytes = Buffer.alloc(128, "a")
			const content = input === "buffer" ? bytes : Readable.from([bytes])
			const upload = store.putObject(new S3Object("bucket", "key", content, {}))
			const failed = upload.catch((error: unknown) => error)
			const diskError = new Error("disk write failed")
			try {
				await gate.started
				await setImmediate()
				expect(metadata).not.toHaveBeenCalled()
				gate.release(diskError)
				expect(await failed).toBe(diskError)
				expect(metadata).not.toHaveBeenCalled()
			} finally {
				gate.release()
				await upload.catch(() => {})
				await gate.waitForClose()
				await rm(directory, { recursive: true, force: true })
			}
		},
	)

	it.each([0, 128, 256 * 1024, 1024 * 1024])(
		"makes all %i uploaded bytes immediately readable after delayed writes",
		async (size) => {
			const { s3rver, s3Client } = await createServerAndClient({
				configureBuckets: [{ name: "bucket-a" }],
			})
			const gate = holdObjectWrites()
			const metadata = vi.spyOn(s3rver.store, "putMetadata")
			const bytes = Buffer.from(
				Uint8Array.from({ length: size }, (_, index) => index % 251),
			)
			const parameters = { Bucket: "bucket-a", Key: "object.bin" }
			let completed = false
			const upload = s3Client
				.putObject({ ...parameters, Body: bytes })
				.then((result) => {
					completed = true
					return result
				})
			try {
				await gate.started
				await setImmediate()
				expect(metadata).not.toHaveBeenCalled()
				expect(completed).toBe(false)
				gate.release()
				const result = await upload
				const etag = `"${crypto.createHash("md5").update(bytes).digest("hex")}"`
				expect(result.ETag).toBe(etag)
				const head = await s3Client.headObject(parameters)
				expect(head.ContentLength).toBe(size)
				expect(head.ETag).toBe(etag)
				const object = await s3Client.getObject(parameters)
				expect(object.ContentLength).toBe(size)
				expect(object.ETag).toBe(etag)
				expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(
					bytes,
				)
			} finally {
				gate.release()
				await upload.catch(() => {})
				await gate.waitForClose()
			}
		},
	)
})
