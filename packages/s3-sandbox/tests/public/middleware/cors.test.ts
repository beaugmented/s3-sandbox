import { errorCode, errorMessage, errorResponse } from "../helpers.ts"
import AWS from "aws-sdk"
import fs from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import request from "../http.ts"

import S3rver from "../../../src/s3rver.ts"

describe("CORS Policy Tests", function () {
	const buckets = [
		// provides rules for origins http://a-test.example.com and http://*.bar.com
		{
			name: "bucket0",
			configs: [
				fs.readFileSync(new URL("../fixtures/cors-test0.xml", import.meta.url)),
			],
		},
	]

	it("fails to initialize a configuration with multiple wildcard characters", async function () {
		let error: unknown
		try {
			const server = new S3rver({
				configureBuckets: [
					{
						name: "bucket0",
						configs: [
							fs.readFileSync(
								new URL("../fixtures/cors-invalid0.xml", import.meta.url),
							),
						],
					},
				],
			})
			await server.run()
			await server.close()
		} catch (err: unknown) {
			error = err
		}
		expect(error).to.exist
		expect(errorMessage(error)).to.include(
			" can not have more than one wildcard.",
		)
	})

	it("fails to initialize a configuration with an illegal AllowedMethod", async function () {
		const server = new S3rver({
			configureBuckets: [
				{
					name: "bucket1",
					configs: [
						fs.readFileSync(
							new URL("../fixtures/cors-invalid1.xml", import.meta.url),
						),
					],
				},
			],
		})
		let error: unknown
		try {
			await server.run()
			await server.close()
		} catch (err: unknown) {
			error = err
		}
		expect(error).to.exist
		expect(errorMessage(error)).to.include(
			"Found unsupported HTTP method in CORS config.",
		)
	})

	it("fails to initialize a configuration with missing required fields", async function () {
		const server = new S3rver({
			configureBuckets: [
				{
					name: "bucket2",
					configs: [
						fs.readFileSync(
							new URL("../fixtures/cors-invalid2.xml", import.meta.url),
						),
					],
				},
			],
		})
		let error: unknown
		try {
			await server.run()
			await server.close()
		} catch (err: unknown) {
			error = err
		}
		expect(error).to.exist
		expect(errorCode(error)).to.equal("MalformedXML")
	})

	it("deletes a CORS configuration in an configured bucket", async function () {
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		let error: unknown
		try {
			await s3Client.deleteBucketCors({ Bucket: buckets[0]!.name }).promise()
			await s3Client.getBucketCors({ Bucket: buckets[0]!.name }).promise()
		} catch (err: unknown) {
			error = err
		} finally {
			await server.close()
		}
		expect(error).to.exist
		expect(errorCode(error)).to.equal("NoSuchCORSConfiguration")
	})

	it("adds the Access-Control-Allow-Origin header for a wildcard origin", async function () {
		const origin = "http://a-test.example.com"
		const bucket = {
			name: "foobars",
			configs: [fs.readFileSync("./example/cors.xml")],
		}

		const server = new S3rver({
			configureBuckets: [bucket],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		try {
			await s3Client
				.putObject({
					Bucket: bucket.name,
					Key: "image",
					Body: await fs.promises.readFile(
						new URL("../fixtures/image0.jpg", import.meta.url),
					),
					ContentType: "image/jpeg",
				})
				.promise()
			const url = s3Client.getSignedUrl("getObject", {
				Bucket: bucket.name,
				Key: "image",
			})
			const res = await request(url, {
				headers: { origin },
			})
			expect(res.statusCode).to.equal(200)
			expect(res.headers).to.have.property("access-control-allow-origin", "*")
		} finally {
			await server.close()
		}
	})

	it("adds the Access-Control-Allow-Origin header for a matching origin", async function () {
		const origin = "http://a-test.example.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		try {
			await s3Client
				.putObject({
					Bucket: buckets[0]!.name,
					Key: "image",
					Body: await fs.promises.readFile(
						new URL("../fixtures/image0.jpg", import.meta.url),
					),
					ContentType: "image/jpeg",
				})
				.promise()
			const url = s3Client.getSignedUrl("getObject", {
				Bucket: buckets[0]!.name,
				Key: "image",
			})
			const res = await request(url, {
				headers: { origin },
			})
			expect(res.statusCode).to.equal(200)
			expect(res.headers).to.have.property(
				"access-control-allow-origin",
				origin,
			)
		} finally {
			await server.close()
		}
	})

	it("matches an origin to a CORSRule with a wildcard character", async function () {
		const origin = "http://foo.bar.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		try {
			await s3Client
				.putObject({
					Bucket: buckets[0]!.name,
					Key: "image",
					Body: await fs.promises.readFile(
						new URL("../fixtures/image0.jpg", import.meta.url),
					),
					ContentType: "image/jpeg",
				})
				.promise()
			const url = s3Client.getSignedUrl("getObject", {
				Bucket: buckets[0]!.name,
				Key: "image",
			})
			const res = await request(url, {
				headers: { origin },
			})
			expect(res.statusCode).to.equal(200)
			expect(res.headers).to.have.property(
				"access-control-allow-origin",
				origin,
			)
		} finally {
			await server.close()
		}
	})

	it("omits the Access-Control-Allow-Origin header for a non-matching origin", async function () {
		const origin = "http://b-test.example.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		try {
			await s3Client
				.putObject({
					Bucket: buckets[0]!.name,
					Key: "image",
					Body: await fs.promises.readFile(
						new URL("../fixtures/image0.jpg", import.meta.url),
					),
					ContentType: "image/jpeg",
				})
				.promise()
			const url = s3Client.getSignedUrl("getObject", {
				Bucket: buckets[0]!.name,
				Key: "image",
			})
			const res = await request(url, {
				headers: { origin },
			})
			expect(res.statusCode).to.equal(200)
			expect(res.headers).to.not.have.property("access-control-allow-origin")
		} finally {
			await server.close()
		}
	})

	it("exposes appropriate headers for a range request", async function () {
		const origin = "http://a-test.example.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		try {
			await s3Client
				.putObject({
					Bucket: buckets[0]!.name,
					Key: "image",
					Body: await fs.promises.readFile(
						new URL("../fixtures/image0.jpg", import.meta.url),
					),
					ContentType: "image/jpeg",
				})
				.promise()
			const url = s3Client.getSignedUrl("getObject", {
				Bucket: buckets[0]!.name,
				Key: "image",
			})
			const res = await request(url, {
				headers: { origin, range: "bytes=0-99" },
			})
			expect(res.statusCode).to.equal(206)
			expect(res.headers).to.have.property(
				"access-control-expose-headers",
				"Accept-Ranges, Content-Range",
			)
		} finally {
			await server.close()
		}
	})

	it("responds to OPTIONS requests with allowed headers", async function () {
		const origin = "http://foo.bar.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: buckets[0]!.name,
			Key: "image",
		})
		try {
			const res = await request(url, {
				method: "OPTIONS",
				headers: {
					origin,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "Range, Authorization",
				},
			})
			expect(res.statusCode).to.equal(200)
			expect(res.headers).to.have.property("access-control-allow-origin", "*")
			expect(res.headers).to.have.property(
				"access-control-allow-headers",
				"range, authorization",
			)
		} finally {
			await server.close()
		}
	})

	it("responds to OPTIONS requests with a Forbidden response", async function () {
		const origin = "http://a-test.example.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: buckets[0]!.name,
			Key: "image",
		})
		let error: unknown
		try {
			await request(url, {
				method: "OPTIONS",
				headers: {
					origin,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "Range, Authorization",
				},
			})
		} catch (err: unknown) {
			error = err
		} finally {
			await server.close()
		}
		expect(error).to.exist
		expect(errorResponse(error).statusCode).to.equal(403)
	})

	it("responds to OPTIONS requests with a Forbidden response when CORS is disabled", async function () {
		const origin = "http://foo.bar.com"
		const bucket = { name: "foobar" }
		const server = new S3rver({
			configureBuckets: [bucket],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: bucket.name,
			Key: "image",
		})
		let error: unknown
		try {
			await request(url, {
				method: "OPTIONS",
				headers: {
					origin,
					"Access-Control-Request-Method": "GET",
				},
			})
		} catch (err: unknown) {
			error = err
		} finally {
			await server.close()
		}
		expect(error).to.exist
		expect(errorResponse(error).statusCode).to.equal(403)
	})

	it("responds correctly to OPTIONS requests that dont specify access-control-request-headers", async function () {
		const origin = "http://a-test.example.com"
		const server = new S3rver({
			configureBuckets: [buckets[0]!],
		})
		const { port } = await server.run()
		const s3Client = new AWS.S3({
			accessKeyId: "S3RVER",
			secretAccessKey: "S3RVER",
			endpoint: `http://localhost:${port}`,
			sslEnabled: false,
			s3ForcePathStyle: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: buckets[0]!.name,
			Key: "image",
		})
		try {
			await request(url, {
				method: "OPTIONS",
				headers: {
					origin,
					"Access-Control-Request-Method": "GET",
					// No Access-Control-Request-Headers specified...
				},
			})
		} finally {
			await server.close()
		}
	})
})
