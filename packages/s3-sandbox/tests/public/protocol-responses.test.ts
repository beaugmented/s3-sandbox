import { beforeEach, describe, expect, it } from "vite-plus/test"
import {
	createServerAndClient,
	errorResponse,
	required,
	type TestS3Client,
} from "./helpers.ts"
import request, { type HttpResponse } from "./http.ts"
import { toHttpDate } from "../../src/temporal-tools.ts"

async function expectS3Error(
	pending: Promise<HttpResponse>,
	status: number,
	code: string,
	details: Record<string, string> = {},
) {
	const response = await pending.catch(errorResponse)
	expect(response.statusCode).toBe(status)
	expect(response.headers["content-type"]).toBe("application/xml")
	const xml = String(response.body)
	expect(xml).toContain(`<Code>${code}</Code>`)
	for (const [name, value] of Object.entries(details))
		expect(xml).toContain(`<${name}>${value}</${name}>`)
	return response
}

describe("Protocol response boundaries", () => {
	let client: TestS3Client
	beforeEach(async () => {
		const { s3Client } = await createServerAndClient({
			configureBuckets: [{ name: "bucket-a" }],
		})
		client = s3Client
	})

	it.each([
		...[
			"acl",
			"analytics",
			"encryption",
			"inventory",
			"lifecycle",
			"metrics",
			"notification",
			"policy",
			"publicAccessBlock",
			"replication",
			"requestPayment",
			"tagging",
		].map((query) => ({ method: "PUT", resource: "bucket-a", query })),
		...[
			"acl",
			"analytics",
			"encryption",
			"inventory",
			"lifecycle",
			"metrics",
			"notification",
			"object-lock",
			"policyStatus",
			"publicAccessBlock",
			"replication",
			"requestPayment",
			"tagging",
			"uploads",
		].map((query) => ({ method: "GET", resource: "bucket-a", query })),
		...[
			"encryption",
			"lifecycle",
			"publicAccessBlock",
			"metrics",
			"policy",
			"replication",
			"tagging",
		].map((query) => ({ method: "DELETE", resource: "bucket-a", query })),
		{ method: "PUT", resource: "bucket-a/key", query: "acl" },
		{ method: "POST", resource: "bucket-a/key", query: "select" },
		...["legal-hold", "retention", "torrent"].map((query) => ({
			method: "GET",
			resource: "bucket-a/key",
			query,
		})),
		{ method: "DELETE", resource: "bucket-a/key", query: "tagging" },
	])(
		"reports unsupported $method $resource?$query as an S3 error",
		async ({ method, resource, query }) => {
			await expectS3Error(
				request(`${resource}?${query}`, {
					baseUrl: client.endpoint.href,
					method,
				}),
				501,
				"NotImplemented",
			)
		},
	)

	it.each([
		{ method: "PUT", resource: "bucket-a", query: "location" },
		{ method: "POST", resource: "bucket-a", query: "cors" },
		{ method: "GET", resource: "bucket-a", query: "delete" },
		{ method: "DELETE", resource: "bucket-a", query: "location" },
		{ method: "PUT", resource: "bucket-a/key", query: "uploads" },
		{ method: "POST", resource: "bucket-a/key", query: "acl" },
		{ method: "GET", resource: "bucket-a/key", query: "uploadId" },
		{ method: "DELETE", resource: "bucket-a/key", query: "acl" },
	])(
		"rejects $method on the $query subresource",
		async ({ method, resource, query }) => {
			await expectS3Error(
				request(`${resource}?${query}`, {
					baseUrl: client.endpoint.href,
					method,
				}),
				405,
				"MethodNotAllowed",
				{ Method: method, ResourceType: query.toUpperCase() },
			)
		},
	)

	it("rejects conflicting subresource parameters with their names", async () => {
		const response = await expectS3Error(
			request("bucket-a?cors&website", { baseUrl: client.endpoint.href }),
			400,
			"InvalidArgument",
			{ ArgumentName: "ResourceType", ArgumentValue: "cors" },
		)
		expect(String(response.body)).toContain(
			"Conflicting query string parameters: cors, website",
		)
	})
	it.each(["%", "bucket-a/%", "bucket-a/%FF"])(
		"rejects malformed URI %s",
		async (resource) => {
			await expectS3Error(
				request(resource, { baseUrl: client.endpoint.href }),
				400,
				"InvalidURI",
			)
		},
	)
	it("reports object POST without an operation as unsupported", async () => {
		await expectS3Error(
			request.post("bucket-a/key", { baseUrl: client.endpoint.href }),
			501,
			"NotImplemented",
		)
	})

	it.each([
		"etag",
		"wildcard",
		"modified",
		"different",
		"stale",
		"invalid",
	] as const)("honors the %s conditional GET", async (condition) => {
		const { ETag } = await client.putObject({
			Bucket: "bucket-a",
			Key: "key",
			Body: "object bytes",
		})
		const conditions = {
			etag: { "if-none-match": required(ETag) },
			wildcard: { "if-none-match": "*" },
			modified: {
				"if-modified-since": toHttpDate(
					Temporal.Now.instant().add({ hours: 1 }),
				),
			},
			different: { "if-none-match": '"different"' },
			stale: { "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
			invalid: { "if-modified-since": "invalid" },
		}
		const pending = request("bucket-a/key", {
			baseUrl: client.endpoint.href,
			headers: conditions[condition],
		})
		if (["etag", "wildcard", "modified"].includes(condition)) {
			await expect(pending).rejects.toMatchObject({
				response: { statusCode: 304, body: "" },
			})
		} else {
			expect(await pending).toMatchObject({
				statusCode: 200,
				body: "object bytes",
			})
		}
	})
	it("rejects a malformed multipart copy range", async () => {
		await client.putObject({
			Bucket: "bucket-a",
			Key: "source",
			Body: "source bytes",
		})
		const upload = await client.createMultipartUpload({
			Bucket: "bucket-a",
			Key: "target",
		})
		await expect(
			client.uploadPartCopy({
				Bucket: "bucket-a",
				Key: "target",
				UploadId: upload.UploadId,
				PartNumber: 1,
				CopySource: "/bucket-a/source",
				CopySourceRange: "bytes=invalid",
			}),
		).rejects.toMatchObject({
			name: "InvalidArgument",
			$metadata: { httpStatusCode: 400 },
		})
	})
})
