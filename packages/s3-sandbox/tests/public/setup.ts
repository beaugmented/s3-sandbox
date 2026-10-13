import fs from "node:fs"
import { afterAll, afterEach, beforeEach } from "vite-plus/test"

import S3rver from "../../src/s3rver.ts"

import { instances, resetTmpDir, tmpDir } from "./helpers.ts"

// Change the default options to be more test-friendly

S3rver.defaultOptions.port = 0
S3rver.defaultOptions.silent = true
S3rver.defaultOptions.directory = tmpDir

beforeEach(resetTmpDir)

afterEach(async function () {
	await Promise.all(
		[...instances].map(async (instance) => {
			try {
				await instance.close()
			} catch (err: unknown) {
				console.warn(err)
			}
		}),
	)
	instances.clear()
})

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
