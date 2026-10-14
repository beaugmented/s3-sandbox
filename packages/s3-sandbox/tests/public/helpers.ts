import { z } from "zod"
import { HttpError, type HttpResponse } from "./http.ts"
import { createS3Event } from "../../src/models/event.ts"
import type { ClientRequest, IncomingMessage } from "node:http"
import {
	S3,
	GetObjectCommand,
	PutObjectCommand,
	type S3ClientConfig,
	type CreateMultipartUploadOutput,
	type GetObjectCommandInput,
	type PutObjectCommandInput,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Readable } from "node:stream"
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
	s3Client: S3,
	bucket: string,
	amount: number,
) {
	const padding = amount.toString().length
	const objects = Array.from({ length: amount }, (_, i) => ({
		Bucket: bucket,
		Key: "key" + i.toString().padStart(padding, "0"),
		Body: "Hello!",
	}))

	return pMap(objects, (object) => s3Client.putObject(object), {
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

	const s3Client = new TestS3Client({ endpoint: `http://localhost:${port}` })
	return { s3rver, s3Client }
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

export const clients = new Set<TestS3Client>()

/** SDK v3 client with a mutable endpoint for mounted and virtual-host contract tests. */
export class TestS3Client extends S3 {
	endpoint: URL
	constructor(options: S3ClientConfig & { endpoint: string }) {
		super({
			region: "us-east-1",
			forcePathStyle: true,
			credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
			maxAttempts: 1,
			...options,
		})
		this.endpoint = new URL(options.endpoint)
		this.config.endpoint = async () => ({
			protocol: this.endpoint.protocol,
			hostname: this.endpoint.hostname,
			port:
				Number(this.endpoint.port) ||
				(this.endpoint.protocol === "https:" ? 443 : 80),
			path: this.endpoint.pathname,
		})
		clients.add(this)
	}
	async getSignedUrl(
		operation: "getObject" | "putObject",
		options: (GetObjectCommandInput &
			Omit<PutObjectCommandInput, "Expires">) & {
			Expires?: number
		},
	): Promise<string> {
		const { Expires: expiresIn = 900, ...parameters } = options
		// SDK v3 requires the full bucket URL when bucketEndpoint is enabled.
		const input = {
			...parameters,
			Bucket: this.config.bucketEndpoint
				? this.endpoint.href
				: parameters.Bucket,
		}
		// Endpoint-related middleware captures constructor options in SDK v3.
		const client = this.config.bucketEndpoint
			? new TestS3Client({
					endpoint: this.endpoint.href,
					bucketEndpoint: true,
					forcePathStyle: false,
				})
			: this
		return operation === "getObject"
			? getSignedUrl(client, new GetObjectCommand(input), { expiresIn })
			: getSignedUrl(client, new PutObjectCommand(input), { expiresIn })
	}
}

/** Independent signature-v2 query signer; no implementation signing helpers are imported. */
export function presignV2(
	client: TestS3Client,
	input: { Bucket: string; Key: string; Expires: number },
): string {
	const expires =
		Math.floor(Temporal.Now.instant().epochMilliseconds / 1000) + input.Expires
	const resource = `/${input.Bucket}/${input.Key}`
	const signature = crypto
		.createHmac("sha1", "S3RVER")
		.update(`GET\n\n\n${expires}\n${resource}`)
		.digest("base64")
	const url = new URL(resource, client.endpoint)
	url.search = new URLSearchParams({
		AWSAccessKeyId: "S3RVER",
		Expires: String(expires),
		Signature: signature,
	}).toString()
	return url.href
}

export function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error("Expected a value")
	return value
}

export function bodyBytes(value: unknown): Buffer {
	if (!Buffer.isBuffer(value)) throw new TypeError("Expected a byte buffer")
	return value
}

/** Collect SDK v3's streaming object body for inherited byte assertions. */
export async function readBody(value: unknown): Promise<Buffer> {
	if (Buffer.isBuffer(value)) return value
	if (!(value instanceof Readable))
		throw new TypeError("Expected an object body stream")
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = []
		value.on("data", (chunk: unknown) => {
			if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
			else reject(new TypeError("Expected bytes"))
		})
		value.on("end", () => resolve(Buffer.concat(chunks)))
		value.on("error", reject)
	})
}

export function setTestEndpoint(client: TestS3Client, url: string): void {
	client.endpoint = new URL(url)
}

export function uploadParameters(data: CreateMultipartUploadOutput) {
	return {
		Bucket: required(data.Bucket),
		Key: required(data.Key),
		UploadId: required(data.UploadId),
	}
}

export function errorCode(error: unknown): unknown {
	return error instanceof Error
		? "code" in error
			? error.code
			: error.name
		: undefined
}
export function errorStatus(error: unknown): unknown {
	return error instanceof Error && "$metadata" in error
		? z.object({ httpStatusCode: z.number().optional() }).parse(error.$metadata)
				.httpStatusCode
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
	return z
		.object({
			CopyObjectResult: z.object({
				ETag: z.string(),
				LastModified: z.unknown(),
			}),
		})
		.parse(value).CopyObjectResult
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
				client.endpoint.pathname +
				`${requestOptions.Bucket}/${requestOptions.Key}`,
			headers: {
				"X-Amz-Decoded-Content-Length": chunks.reduce(
					(length, chunk) => length + chunk.length,
					0,
				),
			},
		},
		{ accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
	)
}
