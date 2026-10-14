import {
	TestS3Client,
	nextS3Event,
	createServerAndClient,
	generateTestObjects,
	readBody,
} from "./helpers.ts"
import { Hono } from "hono"
import type { HttpBindings } from "@hono/node-server"
import { createHonoListener } from "./hono.ts"
import crypto from "node:crypto"
import http from "node:http"
import { once } from "node:events"
import fs from "node:fs"
import { beforeEach, describe, expect, it } from "vite-plus/test"
import request from "./http.ts"

import S3rver from "../../src/s3rver.ts"

describe("S3rver", () => {
	describe("#run", () => {
		it("supports running on port 0", async function () {
			const server = new S3rver({
				port: 0,
			})
			const { port } = await server.run()
			await server.close()
			expect(port).to.be.above(0)
		})

		it("creates preconfigured buckets on startup", async function () {
			const buckets = [{ name: "bucket1" }, { name: "bucket2" }]
			const server = new S3rver({
				configureBuckets: buckets,
			})
			const { port } = await server.run()
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}`,
				forcePathStyle: true,
			})
			try {
				const res = await s3Client.listBuckets()
				expect(res.Buckets).to.have.lengthOf(2)
			} finally {
				await server.close()
			}
		})

		it("creates a preconfigured bucket with configs on startup", async function () {
			const bucket = {
				name: "bucket1",
				configs: [
					fs.readFileSync("./example/cors.xml"),
					fs.readFileSync("./example/website.xml"),
				],
			}
			const server = new S3rver({
				configureBuckets: [bucket],
			})
			const { port } = await server.run()
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}`,
				forcePathStyle: true,
			})
			try {
				await s3Client.getBucketCors({ Bucket: bucket.name })
				await s3Client.getBucketWebsite({ Bucket: bucket.name })
			} finally {
				await server.close()
			}
		})
	})

	describe("#close", () => {
		it("cleans up after close if the resetOnClose setting is true", async function () {
			const bucket = { name: "foobars" }

			const server = new S3rver({
				resetOnClose: true,
				configureBuckets: [bucket],
			})
			const { port } = await server.run()
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}`,
				forcePathStyle: true,
			})
			try {
				await generateTestObjects(s3Client, bucket.name, 10)
			} finally {
				await server.close()
			}
			await expect(server.store.listBuckets()).resolves.toHaveLength(0)
		})

		it("does not clean up after close if the resetOnClose setting is false", async function () {
			const bucket = { name: "foobars" }

			const server = new S3rver({
				resetOnClose: false,
				configureBuckets: [bucket],
			})
			const { port } = await server.run()
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}`,
				forcePathStyle: true,
			})
			try {
				await generateTestObjects(s3Client, bucket.name, 10)
			} finally {
				await server.close()
			}
			await expect(server.store.listBuckets()).resolves.toHaveLength(1)
		})

		it("does not clean up after close if the resetOnClose setting is not set", async function () {
			const bucket = { name: "foobars" }

			const server = new S3rver({
				configureBuckets: [bucket],
			})
			const { port } = await server.run()
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}`,
				forcePathStyle: true,
			})
			try {
				await generateTestObjects(s3Client, bucket.name, 10)
			} finally {
				await server.close()
			}
			await expect(server.store.listBuckets()).resolves.toHaveLength(1)
		})
	})

	describe("event 'event'", () => {
		let s3rver: S3rver
		let s3Client: TestS3Client

		beforeEach(async () => {
			;({ s3rver, s3Client } = await createServerAndClient({
				configureBuckets: [{ name: "bucket-a" }, { name: "bucket-b" }],
			}))
		})

		it("triggers an event with a valid message structure", async function () {
			const eventPromise = nextS3Event(s3rver)
			const body = "Hello!"
			await s3Client.putObject({
				Bucket: "bucket-a",
				Key: "testPutKey",
				Body: body,
			})
			const event = await eventPromise
			const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
			expect(event.Records[0].eventTime).to.match(iso8601)
			expect(
				Number.isFinite(
					Temporal.Instant.from(event.Records[0].eventTime).epochMilliseconds,
				),
			).toBe(true)
		})

		it("triggers a Post event", async function () {
			const eventPromise = nextS3Event(s3rver)
			const body = "Hello!"

			const form = new FormData()
			form.append("key", "testPostKey")
			form.append("file", body)
			await request.post("bucket-a", {
				baseUrl: s3Client.endpoint.href,
				body: form,
			})

			const event = await eventPromise
			expect(event.Records[0].eventName).to.equal("ObjectCreated:Post")
			expect(event.Records[0].s3.bucket.name).to.equal("bucket-a")
			expect(event.Records[0].s3.object).to.contain({
				key: "testPostKey",
				size: body.length,
				eTag: crypto.createHash("md5").update(body).digest("hex"),
			})
		})

		it("triggers a Put event", async function () {
			const eventPromise = nextS3Event(s3rver)
			const body = "Hello!"
			await s3Client.putObject({
				Bucket: "bucket-a",
				Key: "testPutKey",
				Body: body,
			})
			const event = await eventPromise
			expect(event.Records[0].eventName).to.equal("ObjectCreated:Put")
			expect(event.Records[0].s3.bucket.name).to.equal("bucket-a")
			expect(event.Records[0].s3.object).to.contain({
				key: "testPutKey",
				size: body.length,
				eTag: crypto.createHash("md5").update(body).digest("hex"),
			})
		})

		it("triggers a Copy event", async function () {
			const body = "Hello!"
			await s3Client.putObject({
				Bucket: "bucket-a",
				Key: "testPut",
				Body: body,
			})
			const eventPromise = nextS3Event(s3rver)
			await s3Client.copyObject({
				Bucket: "bucket-b",
				Key: "testCopy",
				CopySource: "/bucket-a/testPut",
			})
			const event = await eventPromise
			expect(event.Records[0].eventName).to.equal("ObjectCreated:Copy")
			expect(event.Records[0].s3.bucket.name).to.equal("bucket-b")
			expect(event.Records[0].s3.object).to.contain({
				key: "testCopy",
				size: body.length,
			})
		})

		it("triggers a Delete event", async function () {
			const body = "Hello!"
			await s3Client.putObject({
				Bucket: "bucket-a",
				Key: "testDelete",
				Body: body,
			})
			const eventPromise = nextS3Event(s3rver)
			await s3Client.deleteObject({ Bucket: "bucket-a", Key: "testDelete" })
			const event = await eventPromise
			expect(event.Records[0].eventName).to.equal("ObjectRemoved:Delete")
			expect(event.Records[0].s3.bucket.name).to.equal("bucket-a")
			expect(event.Records[0].s3.object).to.contain({
				key: "testDelete",
			})
		})
	})

	it("can be mounted on a subpath in a Hono app", async function () {
		const s3rver = new S3rver({
			configureBuckets: [{ name: "bucket-a" }, { name: "bucket-b" }],
		})
		await s3rver.configureBuckets()

		const app = new Hono<{ Bindings: HttpBindings }>()
		app.get("/health", (context) => context.text("healthy"))
		app.use("/basepath/*", s3rver.getHonoMiddleware("/basepath"))
		const httpServer = http.createServer(createHonoListener(app)).listen(0)
		await once(httpServer, "listening")

		try {
			const boundAddress = httpServer.address()
			if (boundAddress === null || typeof boundAddress === "string")
				throw new Error("Expected a TCP server address")
			const { port } = boundAddress
			const s3Client = new TestS3Client({
				credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
				endpoint: `http://localhost:${port}/basepath`,
				forcePathStyle: true,
			})
			const res = await s3Client.listBuckets()
			expect(res.Buckets).to.have.lengthOf(2)
			await s3Client.putObject({
				Bucket: "bucket-a",
				Key: "text",
				Body: "Hello!",
			})
			const rootResponse = await request(
				`http://localhost:${port}/basepath?ignored=1`,
			)
			expect(rootResponse.statusCode).to.equal(200)
			expect(rootResponse.body).to.contain("bucket-a")
			const health = await request(`http://localhost:${port}/health`)
			expect(health.body).to.equal("healthy")

			const bytes = Buffer.alloc(256 * 1024, 0xff)
			const form = new FormData()
			form.append("key", "posted")
			form.append("file", new Blob([bytes]), "binary.dat")
			const posted = await request.post(
				`http://localhost:${port}/basepath/bucket-a`,
				{
					body: form,
				},
			)
			expect(posted.statusCode).to.equal(204)
			const object = await s3Client.getObject({
				Bucket: "bucket-a",
				Key: "posted",
			})
			expect(await readBody(object.Body)).to.deep.equal(bytes)
		} finally {
			httpServer.close()
			await once(httpServer, "close")
		}
	})
})
