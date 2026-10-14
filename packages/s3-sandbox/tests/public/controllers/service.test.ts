import { required, createServerAndClient } from "../helpers.ts"
import { describe, expect, it } from "vite-plus/test"

describe("Operations on the Service", () => {
	describe("GET Service", () => {
		const buckets = [
			{ name: "bucket1" },
			{ name: "bucket2" },
			{ name: "bucket3" },
			{ name: "bucket4" },
			{ name: "bucket5" },
			{ name: "bucket6" },
		]

		it("returns a list of buckets", async function () {
			const { s3Client } = await createServerAndClient({
				configureBuckets: buckets,
			})
			const data = await s3Client.listBuckets()
			expect(data.Buckets).to.have.lengthOf(6)
			for (const [index, bucket] of required(data.Buckets).entries()) {
				const config = required(buckets[index])
				expect(bucket.Name).to.equal(config.name)
				expect(Number.isFinite(Number(bucket.CreationDate))).to.be.true
			}
		})
	})
})
