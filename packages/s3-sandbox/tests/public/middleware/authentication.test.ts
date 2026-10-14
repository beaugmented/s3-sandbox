import {
	required,
	setTestEndpoint,
	errorResponse,
	type TestS3Client,
	createServerAndClient,
} from "../helpers.ts"
import S3rver from "../../../src/s3rver.ts"
import type { HttpResponse } from "../http.ts"
import { toHttpDate } from "../../../src/temporal-tools.ts"
import express from "express"
import fs from "node:fs"
import { URL } from "node:url"
import { beforeEach, describe, expect, it } from "vite-plus/test"
import request from "../http.ts"

import { toISO8601String } from "../../../src/utils.ts"

describe("REST Authentication", () => {
	let s3rver: S3rver
	let s3Client: TestS3Client
	const buckets = [
		{
			name: "bucket-a",
		},
	]

	beforeEach(async function () {
		;({ s3rver, s3Client } = await createServerAndClient({
			configureBuckets: buckets,
		}))
	})

	it("can GET a signed URL with subdomain bucket", async function () {
		await s3Client
			.putObject({ Bucket: "bucket-a", Key: "text", Body: "Hello!" })
			.promise()
		const endpointHref = s3Client.endpoint.href
		setTestEndpoint(s3Client, `https://s3.amazonaws.com`)
		Object.assign(s3Client.config, {
			s3ForcePathStyle: false,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "text",
		})
		const { host, pathname, searchParams } = new URL(url)
		const res = await request(new URL(pathname, endpointHref), {
			qs: searchParams,
			headers: { host },
		})
		expect(res.body).to.equal("Hello!")
	})

	it("can GET a signed URL with vhost bucket", async function () {
		await s3Client
			.putObject({ Bucket: "bucket-a", Key: "text", Body: "Hello!" })
			.promise()
		const endpointHref = s3Client.endpoint.href
		setTestEndpoint(
			s3Client,
			`${s3Client.endpoint.protocol}//bucket-a:${s3Client.endpoint.port}${s3Client.endpoint.path}`,
		)
		Object.assign(s3Client.config, {
			s3ForcePathStyle: false,
			s3BucketEndpoint: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "text",
		})
		const { host, pathname, searchParams } = new URL(url)
		const res = await request(new URL(pathname, endpointHref), {
			qs: searchParams,
			headers: { host },
		})
		expect(res.body).to.equal("Hello!")
	})

	it("rejects a request specifying multiple auth mechanisms", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
					Signature: "dummysig",
				},
				headers: {
					Authorization: "AWS S3RVER:dummysig",
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(400)
		expect(res.body).to.contain("<Code>InvalidArgument</Code>")
	})

	it("rejects a request with an invalid authorization header [v2]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					Authorization: "AWS S3RVER dummysig",
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(400)
		expect(res.body).to.contain("<Code>InvalidArgument</Code>")
	})

	it("rejects a request with an invalid authorization header [v4]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					// omitting Signature and SignedHeaders components
					Authorization:
						"AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request",
					"X-Amz-Content-SHA256": "UNSIGNED-PAYLOAD",
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(400)
		expect(res.body).to.contain("<Code>AuthorizationHeaderMalformed</Code>")
	})

	it("rejects a request with invalid query params [v2]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					AWSAccessKeyId: "S3RVER",
					Signature: "dummysig",
					// expiration is omitted
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>AccessDenied</Code>")
	})

	it("rejects a request with invalid query params [v4]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
					"X-Amz-Signature": "dummysig",
					// omitting most other parameters for sig v4
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(400)
		expect(res.body).to.contain(
			"<Code>AuthorizationQueryParametersError</Code>",
		)
	})

	it("rejects a request with an incorrect signature in header [v2]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					Authorization: "AWS S3RVER:badsig",
					"X-Amz-Date": toHttpDate(Temporal.Now.instant()),
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>SignatureDoesNotMatch</Code>")
	})

	it("rejects a request with an incorrect signature in query params [v2]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					AWSAccessKeyId: "S3RVER",
					Signature: "badsig",
					Expires:
						(Temporal.Now.instant().epochMilliseconds / 1000).toFixed() + 900,
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>SignatureDoesNotMatch</Code>")
	})

	it("rejects a request with a large time skew", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					Authorization: "AWS S3RVER:dummysig",
					// 20 minutes in the future
					"X-Amz-Date": toHttpDate(
						Temporal.Now.instant().add({ milliseconds: 20000 * 60 }),
					),
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>RequestTimeTooSkewed</Code>")
	})

	it("rejects an expired presigned request [v2]", async function () {
		s3Client.config.update({ signatureVersion: "s3" })
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "mykey",
			Expires: -10, // 10 seconds in the past
		})
		let res!: HttpResponse
		try {
			res = await request(url)
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>AccessDenied</Code>")
	})

	it("rejects an expired presigned request [v4]", async function () {
		s3Client.config.update({ signatureVersion: "v4" })
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "mykey",
			Expires: -10, // 10 seconds in the past
		})
		let res!: HttpResponse
		try {
			res = await request(url)
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>AccessDenied</Code>")
	})

	it("rejects a presigned request with an invalid expiration [v4]", async function () {
		// aws-sdk unfortunately doesn't expose a way to set the timestamp of the request to presign
		// so we have to construct a mostly-valid request ourselves
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
					"X-Amz-Credential": "S3RVER/20060301/us-east-1/s3/aws4_request",
					"X-Amz-SignedHeaders": "host",
					"X-Amz-Signature": "dummysig",
					// 10 minutes in the past
					"X-Amz-Date": toISO8601String(
						Temporal.Now.instant().subtract({ milliseconds: 20000 * 60 }),
					),
					"X-Amz-Expires": 20,
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>AccessDenied</Code>")
	})

	it("overrides response headers in signed GET requests", async function () {
		await s3Client
			.putObject({
				Bucket: "bucket-a",
				Key: "image",
				Body: await fs.promises.readFile(
					new URL("../fixtures/image0.jpg", import.meta.url),
				),
			})
			.promise()
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "image",
			ResponseContentType: "image/jpeg",
			ResponseContentDisposition: "attachment",
		})
		const res = await request(url)
		expect(res.headers["content-type"]).to.equal("image/jpeg")
		expect(res.headers["content-disposition"]).to.equal("attachment")
	})

	it("rejects anonymous requests with response header overrides in GET requests", async function () {
		await s3Client
			.putObject({
				Bucket: "bucket-a",
				Key: "image",
				Body: await fs.promises.readFile(
					new URL("../fixtures/image0.jpg", import.meta.url),
				),
			})
			.promise()
		let res!: HttpResponse
		try {
			res = await request("bucket-a/image", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					"response-content-type": "image/jpeg",
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(400)
		expect(res.body).to.contain("<Code>InvalidRequest</Code>")
	})

	it("adds x-amz-meta-* metadata specified via query parameters", async function () {
		const url = s3Client.getSignedUrl("putObject", {
			Bucket: "bucket-a",
			Key: "mykey",
			Metadata: {
				somekey: "value",
			},
		})
		await request.put(url, { body: "Hello!" })
		const object = await s3Client
			.headObject({
				Bucket: "bucket-a",
				Key: "mykey",
			})
			.promise()
		expect(object.Metadata).to.have.property("somekey", "value")
	})

	it("can use signed URLs while mounted on a subpath", async function () {
		const app = express()
		app.use("/basepath", s3rver.getMiddleware())

		const { httpServer } = s3rver
		required(httpServer).removeAllListeners("request")
		required(httpServer).on("request", app)
		setTestEndpoint(
			s3Client,
			`${s3Client.endpoint.protocol}//localhost:${s3Client.endpoint.port}/basepath`,
		)

		await s3Client
			.putObject({ Bucket: "bucket-a", Key: "text", Body: "Hello!" })
			.promise()
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "text",
		})
		const res = await request(url)
		expect(res.body).to.equal("Hello!")
	})

	it("can use signed vhost URLs while mounted on a subpath", async function () {
		await s3Client
			.putObject({ Bucket: "bucket-a", Key: "text", Body: "Hello!" })
			.promise()

		const app = express()
		app.use("/basepath", s3rver.getMiddleware())

		const { httpServer } = s3rver
		required(httpServer).removeAllListeners("request")
		required(httpServer).on("request", app)

		const endpointHref = s3Client.endpoint.href
		setTestEndpoint(
			s3Client,
			`${s3Client.endpoint.protocol}//bucket-a:${s3Client.endpoint.port}/basepath`,
		)
		Object.assign(s3Client.config, {
			s3ForcePathStyle: false,
			s3BucketEndpoint: true,
		})
		const url = s3Client.getSignedUrl("getObject", {
			Bucket: "bucket-a",
			Key: "text",
		})
		const { host, pathname, searchParams } = new URL(url)
		const res = await request(new URL(pathname, endpointHref), {
			qs: searchParams,
			headers: { host },
		})
		expect(res.body).to.equal("Hello!")
	})

	it("rejects a request with an incorrect signature in header [v4]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				headers: {
					Authorization:
						"AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=badsig",
					"X-Amz-Content-SHA256": "UNSIGNED-PAYLOAD",
					"X-Amz-Date": toISO8601String(Temporal.Now.instant()),
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>SignatureDoesNotMatch</Code>")
	})

	it("rejects a request with an incorrect signature in query params [v4]", async function () {
		let res!: HttpResponse
		try {
			res = await request("bucket-a/mykey", {
				baseUrl: s3Client.endpoint.href,
				qs: {
					"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
					"X-Amz-Credential": "S3RVER/20200815/eu-west-2/s3/aws4_request",
					"X-Amz-Date": toISO8601String(Temporal.Now.instant()),
					"X-Amz-Expires": 30,
					"X-Amz-SignedHeaders": "host",
					"X-Amz-Signature": "badsig",
				},
			})
		} catch (err: unknown) {
			res = errorResponse(err)
		}
		expect(res.statusCode).to.equal(403)
		expect(res.body).to.contain("<Code>SignatureDoesNotMatch</Code>")
	})
})
