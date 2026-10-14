import { Sha256Node } from "@smithy/core/checksum"
import { SignatureV4, getSigningKey } from "@smithy/signature-v4"
import { createHash, createHmac } from "node:crypto"
import type { RequestOptions } from "node:http"
import { toISO8601String } from "../../src/temporal-tools.ts"

type Credentials = { accessKeyId: string; secretAccessKey: string }
type SignedNodeRequest = RequestOptions & { headers: Record<string, string> }
export type SigningRequest = {
	method: string
	protocol: string
	hostname: string
	port?: number
	path: string
	headers: Record<string, string | number>
	body?: string | Buffer
}
const sandboxCredentials: Credentials = {
	accessKeyId: "S3RVER",
	secretAccessKey: "S3RVER",
}

function createSigner(credentials: Credentials): SignatureV4 {
	return new SignatureV4({
		credentials,
		region: "us-east-1",
		service: "s3",
		sha256: Sha256Node,
		uriEscapePath: false,
	})
}

async function sign(
	signer: SignatureV4,
	request: SigningRequest,
	instant: Temporal.Instant,
): Promise<SignedNodeRequest> {
	const question = request.path.indexOf("?")
	const query = new Map<string, string[]>()
	if (question >= 0) {
		for (const [key, value] of new URLSearchParams(
			request.path.slice(question + 1),
		)) {
			const values = query.get(key) ?? []
			values.push(value)
			query.set(key, values)
		}
	}
	const headers = Object.fromEntries(
		Object.entries(request.headers).map(([key, value]) => [
			key.toLowerCase(),
			String(value),
		]),
	)
	headers.host ??= request.hostname + (request.port ? `:${request.port}` : "")
	const signed = await signer.sign(
		{
			...request,
			path: question < 0 ? request.path : request.path.slice(0, question),
			query: Object.fromEntries(query),
			headers,
		},
		{
			signingDate: instant.toString(),
			signableHeaders: new Set(["content-length"]),
		},
	)
	return { ...request, headers: signed.headers }
}

/** Sign raw Node requests without normalizing object paths through a Fetch URL. */
export function signRawRequest(
	request: SigningRequest,
	instant = Temporal.Now.instant(),
): Promise<SignedNodeRequest> {
	return sign(createSigner(sandboxCredentials), request, instant)
}

/** S3 chunk framing, independently checked against AWS's published signature vectors. */
export class StreamingRequestSigner {
	readonly request: SigningRequest
	private readonly credentials: Credentials
	private readonly instant: Temporal.Instant
	private readonly signer: SignatureV4
	private previousSignature = ""
	private signingKey: Uint8Array | undefined

	constructor(
		request: SigningRequest,
		credentials = sandboxCredentials,
		instant = Temporal.Now.instant(),
	) {
		this.request = request
		this.credentials = credentials
		this.instant = instant
		this.signer = createSigner(credentials)
	}

	async sign(): Promise<SignedNodeRequest> {
		this.request.headers["X-Amz-Content-Sha256"] =
			"STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
		const signed = await sign(this.signer, this.request, this.instant)
		const authorization = signed.headers?.authorization
		if (typeof authorization !== "string")
			throw new Error("Expected a signed Authorization header")
		this.previousSignature = authorization.split("Signature=")[1] ?? ""
		this.signingKey = await getSigningKey(
			Sha256Node,
			this.credentials,
			toISO8601String(this.instant).slice(0, 8),
			"us-east-1",
			"s3",
		)
		return signed
	}

	signChunk(data: Buffer | string): string {
		if (!this.signingKey || !this.previousSignature)
			throw new Error("Sign the request before signing its chunks")
		const bytes = Buffer.from(data)
		const timestamp = toISO8601String(this.instant)
		const stringToSign = [
			"AWS4-HMAC-SHA256-PAYLOAD",
			timestamp,
			`${timestamp.slice(0, 8)}/us-east-1/s3/aws4_request`,
			this.previousSignature,
			createHash("sha256").update("").digest("hex"),
			createHash("sha256").update(bytes).digest("hex"),
		].join("\n")
		this.previousSignature = createHmac("sha256", this.signingKey)
			.update(stringToSign)
			.digest("hex")
		return `${bytes.length.toString(16)};chunk-signature=${this.previousSignature}`
	}
}
