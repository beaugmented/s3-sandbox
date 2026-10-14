import { once } from "node:events"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { describe, expect, it } from "vite-plus/test"
import MultipartParser, {
	createMultipartParser,
	type MultipartOptions,
} from "../../src/multipart/parser.ts"
import {
	basename,
	getDecoder,
	parseContentType,
	parseDisposition,
} from "../../src/multipart/parameters.ts"

const boundary = "edge-boundary"
const conType = {
	type: "multipart",
	subtype: "form-data",
	params: { boundary },
}
type Part = { headers: string; body: string | Buffer }
function form(parts: Part[]) {
	return Buffer.concat([
		...parts.flatMap((part) => [
			Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`),
			Buffer.from(part.body),
			Buffer.from("\r\n"),
		]),
		Buffer.from(`--${boundary}--\r\n`),
	])
}
const field = (name: string, body: string): Part => ({
	headers: `Content-Disposition: form-data; name="${name}"`,
	body,
})
const file = (name: string, body: string): Part => ({
	headers: `Content-Disposition: form-data; name="file"; filename="${name}"`,
	body,
})

async function collect(
	parts: Part[],
	options: Omit<MultipartOptions, "conType"> = {},
) {
	const parser = new MultipartParser({ conType, ...options })
	const fields: Array<{ name: string; value: string; truncated: boolean }> = []
	const files: Array<{
		filename: string
		bytes: Buffer
		truncated: boolean
		limits: number
	}> = []
	const limits: string[] = []
	for (const event of ["filesLimit", "fieldsLimit", "partsLimit"])
		parser.on(event, () => limits.push(event))
	parser.on(
		"field",
		(name: string, value: string, info: { valueTruncated: boolean }) =>
			fields.push({ name, value, truncated: info.valueTruncated }),
	)
	parser.on(
		"file",
		(
			_name: string,
			stream: Readable & { truncated: boolean },
			info: { filename: string },
		) => {
			const chunks: Buffer[] = []
			let count = 0
			stream.on("limit", () => count++)
			stream.on("data", (chunk: Buffer) => chunks.push(chunk))
			stream.on("end", () =>
				files.push({
					filename: info.filename,
					bytes: Buffer.concat(chunks),
					truncated: stream.truncated,
					limits: count,
				}),
			)
			stream.on("error", () => {})
		},
	)
	await pipeline(Readable.from([form(parts)]), parser)
	return { fields, files, limits }
}

describe("Multipart limits and part selection", () => {
	it("preserves boundary prefixes in text fields delivered one byte at a time", async () => {
		const value = "before\r\n--edge! after"
		const parser = new MultipartParser({ conType })
		const fields: string[] = []
		parser.on("field", (_name: string, text: string) => fields.push(text))
		await pipeline(
			Readable.from(
				Array.from(form([field("key", value)]), (byte) => Buffer.from([byte])),
			),
			parser,
		)
		expect(fields).toEqual([value])
	})
	it("accepts folded disposition headers and uses the first repeated header", async () => {
		const result = await collect([
			{
				headers:
					'Content-Disposition: form-data;\r\n\tname="key"\r\nContent-Disposition: form-data; name="ignored"',
				body: "value",
			},
		])
		expect(result.fields).toEqual([
			{ name: "key", value: "value", truncated: false },
		])
	})
	it.each(["-X", "\rX", "X"])(
		"ignores boundary-like preamble with suffix %j",
		async (suffix) => {
			const parser = new MultipartParser({ conType })
			const fields: string[] = []
			parser.on("field", (_name: string, value: string) => fields.push(value))
			await pipeline(
				Readable.from([
					Buffer.from(`--${boundary}${suffix} ignored\r\n`),
					form([field("key", "kept")]),
				]),
				parser,
			)
			expect(fields).toEqual(["kept"])
			expect(parser.complete).toBe(true)
		},
	)
	it("truncates file bytes at the configured limit and still parses following fields", async () => {
		expect(
			await collect([file("a.bin", "abcdef"), field("key", "value")], {
				limits: { fileSize: 3 },
			}),
		).toEqual({
			fields: [{ name: "key", value: "value", truncated: false }],
			files: [
				{
					filename: "a.bin",
					bytes: Buffer.from("abc"),
					truncated: true,
					limits: 1,
				},
			],
			limits: [],
		})
	})
	it("marks oversized text fields as truncated and continues to the file", async () => {
		expect(
			await collect([field("key", "abcdef"), file("a.bin", "bytes")], {
				limits: { fieldSize: 3 },
			}),
		).toEqual({
			fields: [{ name: "key", value: "abc", truncated: true }],
			files: [
				{
					filename: "a.bin",
					bytes: Buffer.from("bytes"),
					truncated: false,
					limits: 0,
				},
			],
			limits: [],
		})
	})
	it("emits file and field count limits once while ignoring excess parts", async () => {
		const result = await collect(
			[
				file("first.bin", "first"),
				file("second.bin", "second"),
				file("third.bin", "third"),
				field("first", "one"),
				field("second", "two"),
				field("third", "three"),
			],
			{ limits: { files: 1, fields: 1 } },
		)
		expect(result).toEqual({
			fields: [{ name: "first", value: "one", truncated: false }],
			files: [
				{
					filename: "first.bin",
					bytes: Buffer.from("first"),
					truncated: false,
					limits: 0,
				},
			],
			limits: ["filesLimit", "fieldsLimit"],
		})
	})
	it("stops emitting parts after the total count limit", async () => {
		expect(
			await collect(
				[
					field("first", "one"),
					file("ignored.bin", "two"),
					field("third", "three"),
				],
				{ limits: { parts: 1 } },
			),
		).toEqual({
			fields: [{ name: "first", value: "one", truncated: false }],
			files: [],
			limits: ["partsLimit"],
		})
	})
	it("skips parts without a valid form-data disposition", async () => {
		expect(
			await collect([
				{ headers: "X-Other: value", body: "ignored" },
				{
					headers: 'Content-Disposition: attachment; name="key"',
					body: "ignored",
				},
				{ headers: "Content-Disposition: form-data; name=", body: "ignored" },
				field("key", "kept"),
			]),
		).toEqual({
			fields: [{ name: "key", value: "kept", truncated: false }],
			files: [],
			limits: [],
		})
	})
	it("consumes unobserved file and field parts without blocking completion", async () => {
		const parser = new MultipartParser({ conType })
		await pipeline(
			Readable.from([
				form([file("ignored.bin", "bytes"), field("key", "value")]),
			]),
			parser,
		)
		expect(parser.complete).toBe(true)
		expect(parser.pendingFiles).toBe(0)
	})
	it("decodes a field's declared charset and strips filename directories", async () => {
		const result = await collect([
			{
				headers:
					'Content-Disposition: form-data; name="key"\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit',
				body: Buffer.from([233]),
			},
			file("directory/a.bin", "bytes"),
		])
		expect(result.fields).toEqual([
			{ name: "key", value: "é", truncated: false },
		])
		expect(result.files[0]?.filename).toBe("a.bin")
		expect(
			(
				await collect([file("directory/a.bin", "bytes")], {
					preservePath: true,
				})
			).files[0]?.filename,
		).toBe("directory/a.bin")
	})
	it.each(["", "text/plain", "multipart/mixed; boundary=a"])(
		"rejects unsupported content type %s",
		(contentType) => {
			expect(() =>
				createMultipartParser({ "content-type": contentType }),
			).toThrow("Unsupported Content-Type")
		},
	)
	it("destroys an unfinished file when the parser is destroyed without an explicit error", async () => {
		const parser = new MultipartParser({ conType })
		const selected = new Promise<Readable>((resolve) =>
			parser.once("file", (_name: string, stream: Readable) => resolve(stream)),
		)
		const parserError = once(parser, "error")
		parser.write(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n\r\nbytes`,
			),
		)
		const stream = await selected
		const fileError = once(stream, "error")
		parser.destroy()
		expect(await parserError).toEqual([
			expect.objectContaining({ message: "Unexpected end of form" }),
		])
		expect(await fileError).toEqual([
			expect.objectContaining({ message: "Unexpected end of file" }),
		])
		expect(stream.destroyed).toBe(true)
	})
})

describe("Multipart header parameter boundaries", () => {
	it.each([
		{ value: String.raw`"a\"b"`, expected: 'a"b' },
		{ value: String.raw`"a\\b"`, expected: "a\\b" },
		{ value: String.raw`"a\zb"`, expected: "a\\zb" },
		{ value: "plain", expected: "plain" },
		{ value: '""', expected: "" },
	])("decodes quoted and unquoted values $value", ({ value, expected }) => {
		expect(
			parseContentType(`text/plain; charset=${value}`)?.params.charset,
		).toBe(expected)
		expect(
			parseDisposition(`form-data; name=${value}`, (text) => text)?.params.name,
		).toBe(expected)
	})
	it.each(["=bad", "bad value", '"unterminated', '"bad\nvalue"', ";other=x"])(
		"rejects malformed values %s",
		(value) => {
			expect(parseContentType(`text/plain; charset=${value}`)).toBeUndefined()
			expect(
				parseDisposition(`form-data; name=${value}`, (text) => text),
			).toBeUndefined()
		},
	)
	it("decodes ASCII escapes in extended filenames and rejects invalid parameter names", () => {
		expect(
			parseDisposition("form-data; filename*=UTF-8''a%20b.txt", (text) => text)
				?.params["filename*"],
		).toBe("a b.txt")
		expect(
			parseDisposition(
				"form-data; filename*=UTF-8''a%20b.txt; name=file",
				(text) => text,
			)?.params,
		).toEqual({ "filename*": "a b.txt", name: "file" })
		expect(
			parseDisposition("form-data; bad/name=value", (text) => text),
		).toBeUndefined()
	})
	it.each(["directory/file.txt", "C:\\directory\\file.txt", "/file.txt"])(
		"strips directories from %s",
		(value) => {
			expect(basename(value)).toBe("file.txt")
		},
	)
	it.each([".", "..", "directory/.", "directory/.."])(
		"discards traversal filename %s",
		(value) => {
			expect(basename(value)).toBe("")
		},
	)
	it("preserves already-decoded ASCII and Latin-1 parameter strings", () => {
		expect(getDecoder("utf8")("ASCII", 0)).toBe("ASCII")
		expect(getDecoder("latin1")("é", 2)).toBe("é")
	})
})
