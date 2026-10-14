import { describe, expect, it } from "vite-plus/test"
import { selectMetadata } from "../../src/metadata.ts"
import S3Error from "../../src/models/error.ts"
import { S3CorsConfiguration } from "../../src/models/config.ts"

describe("Native utility replacements", () => {
	it("retains inherited protocol metadata and filters unrelated fields", () => {
		const metadata = {
			"content-type": "text/plain",
			"x-amz-meta-label": "inherited",
		}
		const inherited = { other: "discard" }
		Object.setPrototypeOf(inherited, metadata)
		expect(selectMetadata(inherited, ["content-type"])).toEqual(metadata)
	})
	it("retains inherited error status without copying reserved error fields", () => {
		const error = new Error("private")
		const prototype = Object.assign(new Error(), {
			status: 503,
			code: "private",
			expose: true,
		})
		Object.setPrototypeOf(error, prototype)
		const converted = S3Error.fromError(error)
		expect(converted.status).toBe(503)
		expect(converted.code).toBe("InternalError")
		expect(converted.message).toBe("private")
	})
	it("treats punctuation literally around the single CORS wildcard", () => {
		const pattern = S3CorsConfiguration.createWildcardRegExp(
			"https://a+b.*.example.com",
		)
		expect(pattern.test("https://a+b.dev.example.com")).toBe(true)
		expect(pattern.test("https://ab.dev.example.com")).toBe(false)
	})
})
