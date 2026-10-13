import times from "lodash/times.js"
import AWS from "aws-sdk"
import aws4 from "aws4"
import * as he from "he"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pMap from "p-map"
import xmlParser from "../../src/xml.ts"
const { RequestSigner } = aws4

import S3rver from "../../src/s3rver.ts"

export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sandbox-test-"))

const instances = new Set<S3rver>()

export const resetTmpDir = function resetTmpDir() {
	fs.rmSync(tmpDir, { recursive: true, force: true })
	fs.mkdirSync(tmpDir, { recursive: true })
}

export const generateTestObjects = function generateTestObjects(
	s3Client: any,
	bucket: any,
	amount: any,
) {
	const padding = amount.toString().length
	const objects = times(amount, (i) => ({
		Bucket: bucket,
		Key: "key" + i.toString().padStart(padding, "0"),
		Body: "Hello!",
	}))

	return pMap(objects, (object) => s3Client.putObject(object).promise(), {
		concurrency: 100,
	})
}

export const md5 = (data: any) =>
	crypto.createHash("md5").update(data).digest("hex")

export const parseXml = (data: any) =>
	xmlParser.parse(data, {
		tagValueProcessor: (a) => he.decode(a),
	})

export const createServerAndClient = async function createServerAndClient(
	options: any,
) {
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
		const hash = (string: any, encoding: any) =>
			crypto.createHash("sha256").update(string, "utf8").digest(encoding)

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
