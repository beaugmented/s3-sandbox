import { describe, expect, it } from "vite-plus/test"
import { StreamingRequestSigner } from "../public/signing.ts"
// cspell:ignore examplebucket AKIAIOSFODNN

describe("Independent S3 signing fixtures", () => {
	// AWS's example fixes credentials, timestamp, request headers, and all three chunk signatures:
	// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-streaming.html
	it("matches AWS's published seed and chained upload signatures", async () => {
		const signer = new StreamingRequestSigner(
			{
				protocol: "https:",
				hostname: "s3.amazonaws.com",
				method: "PUT",
				path: "/examplebucket/chunkObject.txt",
				headers: {
					"Content-Encoding": "aws-chunked",
					"Content-Length": 66824,
					"X-Amz-Decoded-Content-Length": 66560,
					"X-Amz-Storage-Class": "REDUCED_REDUNDANCY",
				},
			},
			{
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			},
			Temporal.Instant.from("2013-05-24T00:00:00Z"),
		)
		const request = await signer.sign()
		expect(request.headers?.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
				"SignedHeaders=content-encoding;content-length;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-storage-class, " +
				"Signature=4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9",
		)
		expect(signer.signChunk(Buffer.alloc(65536, "a"))).toBe(
			"10000;chunk-signature=ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648",
		)
		expect(signer.signChunk(Buffer.alloc(1024, "a"))).toBe(
			"400;chunk-signature=0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497",
		)
		expect(signer.signChunk("")).toBe(
			"0;chunk-signature=b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9",
		)
	})
})
