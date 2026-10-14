import { describe, expect, it } from "vite-plus/test"
import { getConfigModel, S3CorsConfiguration } from "../../src/models/config.ts"

describe("Configuration helpers", () => {
	it("filters requested CORS headers after trimming and case normalization", () => {
		const config = S3CorsConfiguration.validate(
			"<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>X-Amz-*</AllowedHeader></CORSRule></CORSConfiguration>",
		)
		const rule = config.rules[0]!
		expect(
			config.getAllowedHeaders(rule, [
				" X-Amz-Meta-Name ",
				"Content-Type",
				"x-amz-date",
			]),
		).toEqual(["x-amz-meta-name", "x-amz-date"])
		expect(config.getAllowedHeaders(rule, undefined)).toEqual([])
	})
	it("does not resolve an unsupported configuration model", () => {
		expect(getConfigModel("unknown")).toBeUndefined()
	})
})
