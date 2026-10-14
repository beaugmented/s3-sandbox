import {
	parseObjectListing,
	parseBucketListing,
	required,
	createServerAndClient,
} from "../helpers.ts"
import { describe, expect, it } from "vite-plus/test"

import os from "node:os"
import request from "../http.ts"

describe("Virtual Host resolution", () => {
	const buckets = [{ name: "bucket-a" }, { name: "bucket-b" }]

	it("lists objects with subdomain-domain style bucket access", async function () {
		const { s3Client } = await createServerAndClient({
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: "bucket-a.s3.amazonaws.com" },
		})
		expect(res.body).to.include(`<Name>bucket-a</Name>`)
	})

	it("lists objects with a vhost-style bucket access", async function () {
		const { s3Client } = await createServerAndClient({
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: "bucket-a" },
		})
		expect(res.body).to.include(`<Name>bucket-a</Name>`)
	})

	it("lists buckets when vhost-style bucket access is disabled", async function () {
		const { s3Client } = await createServerAndClient({
			vhostBuckets: false,
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: "bucket-a" },
		})
		const parsedBody = parseBucketListing(res.body)
		expect(parsedBody).to.haveOwnProperty("ListAllMyBucketsResult")
		const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket
		expect(parsedBuckets).to.be.instanceOf(Array)
		expect(parsedBuckets).to.have.lengthOf(buckets.length)
		for (const [index, bucket] of (Array.isArray(parsedBuckets)
			? parsedBuckets
			: [parsedBuckets]
		).entries()) {
			const config = required(buckets[index])
			expect(bucket.Name).to.equal(config.name)
			expect(
				Number.isFinite(
					Temporal.Instant.from(bucket.CreationDate).epochMilliseconds,
				),
			).to.be.true
		}
	})

	it("lists buckets at a custom service endpoint", async function () {
		const { s3Client } = await createServerAndClient({
			serviceEndpoint: "example.com",
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: "s3.example.com" },
		})
		const parsedBody = parseBucketListing(res.body)
		expect(parsedBody).to.haveOwnProperty("ListAllMyBucketsResult")
		const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket
		expect(parsedBuckets).to.be.instanceOf(Array)
		expect(parsedBuckets).to.have.lengthOf(buckets.length)
		for (const [index, bucket] of (Array.isArray(parsedBuckets)
			? parsedBuckets
			: [parsedBuckets]
		).entries()) {
			const config = required(buckets[index])
			expect(bucket.Name).to.equal(config.name)
			expect(
				Number.isFinite(
					Temporal.Instant.from(bucket.CreationDate).epochMilliseconds,
				),
			).to.be.true
		}
	})

	it("lists buckets at the OS hostname", async function () {
		const { s3Client } = await createServerAndClient({
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: os.hostname() },
		})
		const parsedBody = parseBucketListing(res.body)
		expect(parsedBody).to.haveOwnProperty("ListAllMyBucketsResult")
		const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket
		expect(parsedBuckets).to.be.instanceOf(Array)
		expect(parsedBuckets).to.have.lengthOf(buckets.length)
		for (const [index, bucket] of (Array.isArray(parsedBuckets)
			? parsedBuckets
			: [parsedBuckets]
		).entries()) {
			const config = required(buckets[index])
			expect(bucket.Name).to.equal(config.name)
			expect(
				Number.isFinite(
					Temporal.Instant.from(bucket.CreationDate).epochMilliseconds,
				),
			).to.be.true
		}
	})

	it("lists objects in a bucket at a custom service endpoint", async function () {
		const { s3Client } = await createServerAndClient({
			serviceEndpoint: "example.com",
			configureBuckets: buckets,
		})
		const res = await request(s3Client.endpoint.href, {
			headers: { host: "bucket-a.s3.example.com" },
		})
		const parsedBody = parseObjectListing(res.body)
		expect(parsedBody.ListBucketResult.Name).to.equal("bucket-a")
	})
})
