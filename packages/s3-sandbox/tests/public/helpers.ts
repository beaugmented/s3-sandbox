import { z } from "zod"
import { HttpError, type HttpResponse } from "./http.ts"
import { createS3Event } from "../../src/models/event.ts"
import type { ClientRequest, IncomingMessage } from "node:http"
import AWS from "aws-sdk"
import aws4 from "aws4"
import * as he from "he"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pMap from "p-map"
import * as xmlParser from "../../src/xml.ts"
const { RequestSigner } = aws4

import S3rver, { type S3SandboxOptions } from "../../src/s3rver.ts"

export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sandbox-test-"))

const instances = new Set<S3rver>()

export function resetTmpDir() {
	fs.rmSync(tmpDir, { recursive: true, force: true })
	fs.mkdirSync(tmpDir, { recursive: true })
}

export function generateTestObjects(
	s3Client: AWS.S3,
	bucket: string,
	amount: number,
) {
	const padding = amount.toString().length
	const objects = Array.from({ length: amount }, (_, i) => ({
		Bucket: bucket,
		Key: "key" + i.toString().padStart(padding, "0"),
		Body: "Hello!",
	}))

	return pMap(objects, (object) => s3Client.putObject(object).promise(), {
		concurrency: 100,
	})
}

export function md5(data: unknown): string {
	if (typeof data !== "string" && !Buffer.isBuffer(data))
		throw new TypeError("Expected text or bytes")
	return crypto.createHash("md5").update(data).digest("hex")
}

export const parseXml = (data: string | Buffer) =>
	xmlParser.parse(data, {
		tagValueProcessor: (a) => he.decode(a),
	})

export async function createServerAndClient(options: S3SandboxOptions = {}) {
	const s3rver = new S3rver(options)
	const { port } = await s3rver.run()
	instances.add(s3rver)

	const s3Client = new AWS.S3({
		accessKeyId: "S3RVER",
		secretAccessKey: "S3RVER",
		endpoint: `localhost:${port}`,
		sslEnabled: false,
		s3ForcePathStyle: true,
		signatureVersion: "v4",
	})

	return {
		s3rver,
		s3Client: Object.assign(s3Client, {
			endpoint: Object.assign(new AWS.Endpoint(`http://localhost:${port}`), {
				path: "/",
			}),
		}),
	}
}

export { instances }

export class StreamingRequestSigner extends RequestSigner {
	declare previousSignature: string
	declare chunkData: Buffer | undefined
	prepareRequest() {
		;(this.request.headers ??= {})["X-Amz-Content-Sha256"] =
			"STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
		return super.prepareRequest()
	}

	signature() {
		this.previousSignature = super.signature()
		this.chunkData = undefined
		return this.previousSignature
	}

	signChunk(chunkData: Buffer | string) {
		this.chunkData = Buffer.from(chunkData)
		const chunkLengthHex = chunkData.length.toString(16)
		return `${chunkLengthHex};chunk-signature=${this.signature()}`
	}

	stringToSign() {
		return this.chunkData === undefined
			? super.stringToSign()
			: [
					"AWS4-HMAC-SHA256-PAYLOAD",
					this.getDateTime(),
					this.credentialString(),
					this.previousSignature,
					hash("", "hex"),
					hash(this.chunkData, "hex"),
				].join("\n")
	}
}

export type TestS3Client = Awaited<
	ReturnType<typeof createServerAndClient>
>["s3Client"]

export function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error("Expected a value")
	return value
}

export function bodyBytes(value: unknown): Buffer {
	if (!Buffer.isBuffer(value)) throw new TypeError("Expected a byte buffer")
	return value
}

export function setTestEndpoint(client: TestS3Client, url: string): void {
	client.endpoint = Object.assign(new AWS.Endpoint(url), {
		path: new URL(url).pathname,
	})
}

export function uploadParameters(data: AWS.S3.CreateMultipartUploadOutput) {
	return {
		Bucket: required(data.Bucket),
		Key: required(data.Key),
		UploadId: required(data.UploadId),
	}
}

export function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined
}
export function errorStatus(error: unknown): unknown {
	return error instanceof Error && "statusCode" in error
		? error.statusCode
		: undefined
}
export function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) throw error
	return error.message
}
export function errorResponse(error: unknown): HttpResponse {
	if (!(error instanceof HttpError)) throw error
	return error.response
}

export function parseCopyResult(value: unknown) {
	return z.object({ ETag: z.string(), LastModified: z.unknown() }).parse(value)
}

export function nextS3Event(
	server: S3rver,
): Promise<ReturnType<typeof createS3Event>> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("event", onEvent)
			reject(error)
		}
		const onEvent = (event: ReturnType<typeof createS3Event>) => {
			server.off("error", onError)
			resolve(event)
		}
		server.once("event", onEvent)
		server.once("error", onError)
	})
}

export function response(req: ClientRequest): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			req.off("response", onResponse)
			reject(error)
		}
		const onResponse = (res: IncomingMessage) => {
			req.off("error", onError)
			resolve(res)
		}
		req.once("error", onError)
		req.once("response", onResponse)
	})
}

export function unquoteETag(value: string): string {
	const parsed: unknown = JSON.parse(value)
	return z.string().parse(parsed)
}

function hash(string: string | Buffer, encoding: "hex"): string {
	return crypto.createHash("sha256").update(string, "utf8").digest(encoding)
}

export function parseBucketListing(xml: string | Buffer) {
	return z
		.object({
			ListAllMyBucketsResult: z.object({
				Buckets: z.object({
					Bucket: z.union([
						z.object({ Name: z.string(), CreationDate: z.string() }),
						z.array(z.object({ Name: z.string(), CreationDate: z.string() })),
					]),
				}),
			}),
		})
		.parse(parseXml(xml))
}

export function parseObjectListing(xml: string | Buffer) {
	return z
		.object({ ListBucketResult: z.object({ Name: z.string() }) })
		.parse(parseXml(xml))
}

export function createStreamingSigner(
	client: TestS3Client,
	requestOptions: { Bucket: string; Key: string },
	chunks: Array<string | Buffer>,
) {
	return new StreamingRequestSigner(
		{
			method: "PUT",
			protocol: client.endpoint.protocol,
			hostname: client.endpoint.hostname,
			port: client.endpoint.port,
			path:
				client.endpoint.path + `${requestOptions.Bucket}/${requestOptions.Key}`,
			headers: {
				"X-Amz-Decoded-Content-Length": chunks.reduce(
					(length, chunk) => length + chunk.length,
					0,
				),
			},
		},
		required(client.config.credentials),
	)
}
