import { describe, expect, it } from "vite-plus/test"
import {
	instantFromISO8601,
	iso8601FromInstant,
	parseDate,
	parseHttpDate,
	parseISO8601String,
	toHttpDate,
	toISO8601String,
} from "../../src/temporal-tools.ts"
import { parseQuery } from "../../src/signature/v4.ts"

describe("Temporal protocol boundaries", () => {
	it("keeps UTC millisecond precision at ISO storage boundaries", () => {
		const instant = Temporal.Instant.from("2026-10-13T10:11:12.123456789+02:00")
		const iso = iso8601FromInstant(instant)
		expect(iso).toBe("2026-10-13T08:11:12.123Z")
		expect(instantFromISO8601(iso).epochMilliseconds).toBe(
			instant.epochMilliseconds,
		)
		expect(iso8601FromInstant(null)).toBeNull()
		expect(instantFromISO8601(null)).toBeNull()
	})
	it.each([
		"Sun, 06 Nov 1994 08:49:37 GMT",
		"Sunday, 06-Nov-94 08:49:37 GMT",
		"Sun Nov  6 08:49:37 1994",
	])("parses the HTTP timestamp %s", (value) => {
		expect(parseHttpDate(value)?.toString()).toBe("1994-11-06T08:49:37Z")
		expect(toHttpDate(parseHttpDate(value)!)).toBe(
			"Sun, 06 Nov 1994 08:49:37 GMT",
		)
	})
	it.each([
		"",
		"not a timestamp",
		"Tue, 31 Feb 2026 08:49:37 GMT",
		"20260230T084937Z",
		"2026-02-30T08:49:37Z",
	])("rejects invalid timestamps: %s", (value) => {
		expect(parseDate(value)).toBeNull()
	})
	it("round trips compact AWS timestamps at second precision", () => {
		const instant = Temporal.Instant.from("2026-10-13T08:11:12.999Z")
		expect(toISO8601String(instant)).toBe("20261013T081112Z")
		expect(parseISO8601String("20261013T081112Z")?.toString()).toBe(
			"2026-10-13T08:11:12Z",
		)
		expect(parseISO8601String("2026-10-13T08:11:12Z")).toBeNull()
	})
	it.each(["NaN", "Infinity"])(
		"rejects invalid presigned lifetimes: %s",
		(expires) => {
			expect(() =>
				parseQuery({
					"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
					"X-Amz-Credential": "S3RVER/20261013/us-east-1/s3/aws4_request",
					"X-Amz-Signature": "signature",
					"X-Amz-Date": "20261013T081112Z",
					"X-Amz-SignedHeaders": "host",
					"X-Amz-Expires": expires,
				}),
			).toThrow("X-Amz-Expires must be a finite number")
		},
	)
})
