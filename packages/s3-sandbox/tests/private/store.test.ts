import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import S3Object from "../../src/models/object.ts"
import FilesystemStore from "../../src/stores/filesystem.ts"

describe("Filesystem mechanics", () => {
	it("round-trips Windows-reserved object-key characters", () => {
		const key = 'directory/<>:"\\|?*.txt'
		const encoded = FilesystemStore.encodeKeyPath(key, "win32")
		expect(encoded).not.toContain("*")
		expect(FilesystemStore.decodeKeyPath(encoded, "win32")).toBe(key)
		expect(FilesystemStore.encodeKeyPath(key, "linux")).toBe(key)
	})
	it("finishes buffer writes before resolving and retains the inherited disk layout", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "s3-sandbox-store-"))
		try {
			const store = new FilesystemStore(directory)
			await store.putBucket("bucket")
			const body = Buffer.alloc(128 * 1024, "a")
			await store.putObject(
				new S3Object("bucket", "nested/key.txt", body, {
					"content-type": "text/plain",
				}),
			)
			expect(
				readFileSync(
					path.join(directory, "bucket", "nested", "key.txt._S3rver_object"),
				),
			).toEqual(body)
			expect(
				JSON.parse(
					readFileSync(
						path.join(
							directory,
							"bucket",
							"nested",
							"key.txt._S3rver_metadata.json",
						),
						"utf8",
					),
				),
			).toEqual({ "content-type": "text/plain" })
			store.reset()
			expect(await store.listBuckets()).toEqual([])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
