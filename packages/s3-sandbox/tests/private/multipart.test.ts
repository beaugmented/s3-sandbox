import { describe, expect, it } from "vite-plus/test"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { once } from "node:events"
import { setImmediate } from "node:timers/promises"
import { createMultipartParser } from "../../src/multipart/parser.ts"
import {
	parseContentType,
	parseDisposition,
	getDecoder,
} from "../../src/multipart/parameters.ts"

const boundary = "test-boundary"
const contentType = `multipart/form-data; boundary="${boundary}"`
const payload = Buffer.concat([
	Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\ntext\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
	),
	Buffer.from([0, 255, 13, 10, 1]),
	Buffer.from(`\r\n--${boundary}--\r\n`),
])

async function parse(chunks: Buffer[]) {
	const parser = createMultipartParser({ "content-type": contentType })
	const fields: Record<string, string> = {}
	const files: Buffer[] = []
	parser.on("field", (name: string, value: string) => {
		fields[name] = value
	})
	parser.on("file", (_name: string, file: Readable) => {
		const bytes: Buffer[] = []
		file.on("data", (chunk: Buffer) => bytes.push(chunk))
		file.on("end", () => files.push(Buffer.concat(bytes)))
		file.on("error", () => {
			/* The parser/pipeline also reports the error. */
		})
	})
	await pipeline(Readable.from(chunks), parser)
	return { fields, files }
}

describe("Owned multipart parser", () => {
	it("preserves binary files at every possible two-chunk split", async () => {
		await Promise.all(
			Array.from({ length: payload.length - 1 }, async (_, offset) => {
				const split = offset + 1
				expect(
					await parse([payload.subarray(0, split), payload.subarray(split)]),
					`split ${split}`,
				).toEqual({
					fields: { key: "text" },
					files: [Buffer.from([0, 255, 13, 10, 1])],
				})
			}),
		)
	})
	it("parses headers and closing boundaries arriving one byte at a time", async () => {
		expect(
			await parse(Array.from(payload, (byte) => Buffer.from([byte]))),
		).toEqual({
			fields: { key: "text" },
			files: [Buffer.from([0, 255, 13, 10, 1])],
		})
	})
	it("accepts preamble and epilogue without storing them as file content", async () => {
		expect(
			await parse([
				Buffer.concat([
					Buffer.from("preamble\r\n"),
					payload,
					Buffer.from(
						`epilogue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.bin"\r\n\r\nignored\r\n--${boundary}--\r\n`,
					),
				]),
			]),
		).toEqual({
			fields: { key: "text" },
			files: [Buffer.from([0, 255, 13, 10, 1])],
		})
	})
	it("rejects an incomplete file and closing delimiter", async () => {
		await expect(
			parse([payload.subarray(0, payload.length - 20)]),
		).rejects.toThrow("Unexpected end")
	})
	it("rejects malformed and oversized part headers", async () => {
		await expect(
			parse([
				Buffer.from(
					`--${boundary}\r\nBad Header: value\r\n\r\ndata\r\n--${boundary}--\r\n`,
				),
			]),
		).rejects.toThrow("Malformed part header")
		await expect(
			parse([
				Buffer.from(
					`--${boundary}\r\nX-Long: ${"a".repeat(16384)}\r\n\r\ndata\r\n--${boundary}--\r\n`,
				),
			]),
		).rejects.toThrow("Malformed part header")
	})
	it("rejects a missing boundary without starting a stream", () => {
		expect(() =>
			createMultipartParser({ "content-type": "multipart/form-data" }),
		).toThrow("Boundary not found")
	})
	it("stops reading the request while the file consumer is paused", async () => {
		const parser = createMultipartParser({ "content-type": contentType })
		let reads = 0
		let file: Readable | undefined
		const source = Readable.from(
			(function* chunks() {
				yield Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n\r\n`,
				)
				for (let index = 0; index < 128; index++) {
					reads++
					yield Buffer.alloc(65536)
				}
				yield Buffer.from(`\r\n--${boundary}--\r\n`)
			})(),
		)
		const selected = new Promise<Readable>((resolve) =>
			parser.once("file", (_name: string, stream: Readable) => resolve(stream)),
		)
		const finished = pipeline(source, parser)
		file = await selected
		await setImmediate()
		expect(reads).toBeLessThan(10)
		file.resume()
		await finished
		expect(reads).toBe(128)
	})
	it("destroys the active file when parsing is cancelled", async () => {
		const parser = createMultipartParser({ "content-type": contentType })
		const failure = new Error("cancelled")
		const parserError = once(parser, "error")
		const selected = new Promise<Readable>((resolve) =>
			parser.once("file", (_name: string, file: Readable) => resolve(file)),
		)
		parser.write(
			Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\n\r\n`,
				),
				Buffer.alloc(65536),
			]),
		)
		const file = await selected
		const fileError = once(file, "error")
		parser.destroy(failure)
		expect(await parserError).toEqual([failure])
		expect(await fileError).toEqual([failure])
		expect(file.destroyed).toBe(true)
	})
	it("parses quoted parameters and extended Unicode filenames", () => {
		expect(parseContentType('multipart/form-data; boundary="a;b"')).toEqual({
			type: "multipart",
			subtype: "form-data",
			params: { boundary: "a;b" },
		})
		expect(
			parseDisposition(
				"form-data; name=\"file\"; filename*=UTF-8''snow-%E2%98%83.bin",
				(value) => value,
			)?.params["filename*"],
		).toBe("snow-☃.bin")
		expect(
			parseDisposition("form-data; filename*=UTF-8''bad-%QQ", (value) => value),
		).toBeUndefined()
	})
	it("decodes explicit field character encodings and rejects unsupported ones", () => {
		expect(getDecoder("iso-8859-1")(Buffer.from([233]), 0)).toBe("é")
		expect(getDecoder("utf-16le")(Buffer.from([65, 0]), 0)).toBe("A")
		expect(getDecoder("unknown-charset")(Buffer.from([65]), 0)).toBeUndefined()
		expect(getDecoder("constructor")(Buffer.from([65]), 0)).toBeUndefined()
	})
})
