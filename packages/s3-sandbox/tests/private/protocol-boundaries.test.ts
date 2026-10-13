import { describe, expect, it } from "vite-plus/test"
import S3Error from "../../src/models/error.ts"
import { parseMetadata } from "../../src/metadata.ts"
import { deleteKeys, uploadParts } from "../../src/protocol-xml.ts"
import { protocolHeaders, protocolQuery } from "../../src/protocol-request.ts"

describe("Protocol boundary validation", () => {
	it("normalizes headers without changing the Node request and rejects repeated query values", () => {
		const headers = { host: "localhost", "set-cookie": ["a", "b"] }
		expect(protocolHeaders(headers)).toEqual({
			host: "localhost",
			"set-cookie": "a,b",
		})
		expect(headers["set-cookie"]).toEqual(["a", "b"])
		expect(protocolQuery({ prefix: "folder/" })).toEqual({ prefix: "folder/" })
		const specialNames = Object.fromEntries([
			["__proto__", "value"],
			["constructor", "value"],
		])
		expect(protocolQuery(specialNames)).toEqual(specialNames)
		expect(() => protocolQuery({ prefix: ["a", "b"] })).toThrow(S3Error)
	})
	it("accepts numeric XML keys without losing their string representation", () => {
		expect(
			deleteKeys({ Delete: { Object: [{ Key: 123 }, { Key: "folder/key" }] } }),
		).toEqual(["123", "folder/key"])
	})
	it.each([
		{ Delete: {} },
		{ Delete: { Object: {} } },
		{ CompleteMultipartUpload: { Part: {} } },
	])("rejects incomplete XML operation shapes", (value) => {
		expect(() =>
			"Delete" in value ? deleteKeys(value) : uploadParts(value),
		).toThrow(S3Error)
	})
	it("normalizes multipart XML scalars before accessing them", () => {
		expect(
			uploadParts({
				CompleteMultipartUpload: { Part: { PartNumber: "1", ETag: '"abc"' } },
			}),
		).toEqual([{ number: 1, etag: "abc" }])
	})
	it("rejects malformed stored metadata without propagating untyped JSON", () => {
		expect(
			parseMetadata('{"content-type":"text/plain","content-length":3}'),
		).toEqual({ "content-type": "text/plain", "content-length": 3 })
		expect(() => parseMetadata('{"content-type":{"nested":true}}')).toThrow()
	})
	it("escapes HTML messages and detail keys, including nested errors", () => {
		const error = new S3Error("InvalidArgument", "<script>outer</script>", {
			"<img src=x>": "<script>detail</script>",
		})
		error.errors.push(new S3Error("NoSuchKey", "<script>nested</script>"))
		const html = error.toHTML()
		expect(html).not.toContain("<script>")
		expect(html).not.toContain("<img src=x>")
		expect(html).toContain("&lt;script&gt;outer&lt;/script&gt;")
		expect(html).toContain("&lt;script&gt;nested&lt;/script&gt;")
	})
})
