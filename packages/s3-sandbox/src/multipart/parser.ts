/** Adapted from Brian White's MIT-licensed implementation; see LICENSES/busboy-MIT.txt. */

import { Readable, Writable, type ReadableOptions } from "node:stream"

import ByteMatcher, { type MatchCallback } from "./byte-matcher.ts"

import {
	basename,
	convertToUTF8,
	getDecoder,
	parseContentType,
	parseDisposition,
} from "./parameters.ts"

const BUF_CRLF = Buffer.from("\r\n")
const BUF_CR = Buffer.from("\r")
const BUF_DASH = Buffer.from("-")

function noop() {}

const MAX_HEADER_PAIRS = 2000 // From node
const MAX_HEADER_SIZE = 16 * 1024 // From node (its default value)

const HEADER_NAME = 0
const HEADER_WHITESPACE = 1
const HEADER_VALUE = 2
type PartHeaders = Record<string, string[]>
class HeaderParser {
	declare header: PartHeaders
	declare pairCount: number
	declare byteCount: number
	declare state: number
	declare name: string
	declare value: string
	declare crlf: number
	declare cb: (headers: PartHeaders) => void

	constructor(cb: (headers: PartHeaders) => void) {
		this.header = {}
		Object.setPrototypeOf(this.header, null)
		this.pairCount = 0
		this.byteCount = 0
		this.state = HEADER_NAME
		this.name = ""
		this.value = ""
		this.crlf = 0
		this.cb = cb
	}

	reset() {
		this.header = {}
		Object.setPrototypeOf(this.header, null)
		this.pairCount = 0
		this.byteCount = 0
		this.state = HEADER_NAME
		this.name = ""
		this.value = ""
		this.crlf = 0
	}

	push(chunk: Buffer, pos: number, end: number) {
		let start = pos
		while (pos < end) {
			switch (this.state) {
				case HEADER_NAME: {
					let done = false
					for (; pos < end; ++pos) {
						if (this.byteCount === MAX_HEADER_SIZE) return -1
						++this.byteCount
						const code = chunk[pos]!
						if (TOKEN[code] !== 1) {
							if (code !== 58 /* ':' */) return -1
							this.name += chunk.toString("latin1", start, pos)
							if (this.name.length === 0) return -1
							++pos
							done = true
							this.state = HEADER_WHITESPACE
							break
						}
					}
					if (!done) {
						this.name += chunk.toString("latin1", start, pos)
						break
					}
					// FALLTHROUGH
				}
				case HEADER_WHITESPACE: {
					// Skip optional whitespace
					let done = false
					for (; pos < end; ++pos) {
						if (this.byteCount === MAX_HEADER_SIZE) return -1
						++this.byteCount
						const code = chunk[pos]!
						if (code !== 32 /* ' ' */ && code !== 9 /* '\t' */) {
							start = pos
							done = true
							this.state = HEADER_VALUE
							break
						}
					}
					if (!done) break
					// FALLTHROUGH
				}
				case HEADER_VALUE:
					switch (this.crlf) {
						case 0: // Nothing yet
							for (; pos < end; ++pos) {
								if (this.byteCount === MAX_HEADER_SIZE) return -1
								++this.byteCount
								const code = chunk[pos]!
								if (FIELD_VALUE_CHARACTER[code] !== 1) {
									if (code !== 13 /* '\r' */) return -1
									++this.crlf
									break
								}
							}
							this.value += chunk.toString("latin1", start, pos++)
							break
						case 1: // Received CR
							if (this.byteCount === MAX_HEADER_SIZE) return -1
							++this.byteCount
							if (chunk[pos++] !== 10 /* '\n' */) return -1
							++this.crlf
							break
						case 2: {
							// Received CR LF
							if (this.byteCount === MAX_HEADER_SIZE) return -1
							++this.byteCount
							const code = chunk[pos]!
							if (code === 32 /* ' ' */ || code === 9 /* '\t' */) {
								// Folded value
								start = pos
								this.crlf = 0
							} else {
								if (++this.pairCount < MAX_HEADER_PAIRS) {
									this.name = this.name.toLowerCase()
									if (this.header[this.name] === undefined)
										this.header[this.name] = [this.value]
									else this.header[this.name]!.push(this.value)
								}
								if (code === 13 /* '\r' */) {
									++this.crlf
									++pos
								} else {
									// Assume start of next header field name
									start = pos
									this.crlf = 0
									this.state = HEADER_NAME
									this.name = ""
									this.value = ""
								}
							}
							break
						}
						case 3: {
							// Received CR LF CR
							if (this.byteCount === MAX_HEADER_SIZE) return -1
							++this.byteCount
							if (chunk[pos++] !== 10 /* '\n' */) return -1
							// End of header
							const header = this.header
							this.reset()
							this.cb(header)
							return pos
						}
					}
					break
			}
		}

		return pos
	}
}

class FileStream extends Readable {
	_read(_size: number): void {
		this.resumeWrite()
	}
	declare truncated: boolean
	declare readCallback: (() => void) | null

	constructor(opts: ReadableOptions, owner: MultipartParser) {
		super(opts)
		this.truncated = false
		this.readCallback = null
		this.once("end", () => {
			// We need to make sure that we call any outstanding writeCallback() that is
			// associated with this file so that processing of the rest of the form
			// can continue. This may not happen if the file stream ends right after
			// backpressure kicks in, so we force it here.
			this.resumeWrite()
			if (--owner.pendingFiles === 0 && owner.finalCallback) {
				const cb = owner.finalCallback
				owner.finalCallback = null
				// Make sure other 'end' event handlers get a chance to be executed
				// before the parser's 'finish' event is emitted
				process.nextTick(cb)
			}
		})
	}
	resumeWrite() {
		const cb = this.readCallback
		if (cb) {
			this.readCallback = null
			cb()
		}
	}
}

const ignoreData = {
	push: (_chunk: Buffer, _pos: number) => undefined,
	destroy: () => {},
}

function callAndUnsetCb(self: MultipartParser, err?: Error | null) {
	const cb = self.writeCallback
	self.writeCallback = null
	if (err) self.destroy(err)
	else if (cb) cb()
}

function nullDecoder(val: string) {
	return val
}

type StreamCallback = (error?: Error | null) => void
export type ContentType = {
	type: string
	subtype: string
	params: Record<string, string>
}
export type MultipartOptions = {
	conType: ContentType
	highWaterMark?: number
	fileHwm?: number
	defCharset?: string
	defParamCharset?: string
	preservePath?: boolean
	limits?: {
		fieldSize?: number
		fileSize?: number
		files?: number
		fields?: number
		parts?: number
	}
}
export default class MultipartParser extends Writable {
	declare pendingFiles: number
	declare fileStream: FileStream | null | undefined
	declare complete: boolean
	declare headerParser: HeaderParser | null
	declare boundaryParser: Pick<ByteMatcher, "push" | "destroy">
	declare writeCallback: StreamCallback | null
	declare finalCallback: StreamCallback | null

	constructor(cfg: MultipartOptions) {
		const streamOpts = {
			autoDestroy: true,
			emitClose: true,
			highWaterMark:
				typeof cfg.highWaterMark === "number" ? cfg.highWaterMark : undefined,
		}
		super(streamOpts)

		if (!cfg.conType.params || typeof cfg.conType.params.boundary !== "string")
			throw new Error("MultipartParser: Boundary not found")

		const boundary = cfg.conType.params.boundary
		const paramDecoder =
			typeof cfg.defParamCharset === "string" && cfg.defParamCharset
				? getDecoder(cfg.defParamCharset)
				: nullDecoder
		const defCharset = cfg.defCharset || "utf8"
		const preservePath = cfg.preservePath
		const fileOpts = {
			autoDestroy: true,
			emitClose: true,
			highWaterMark: typeof cfg.fileHwm === "number" ? cfg.fileHwm : undefined,
		}

		const limits = cfg.limits
		const fieldSizeLimit =
			limits && typeof limits.fieldSize === "number"
				? limits.fieldSize
				: 1 * 1024 * 1024
		const fileSizeLimit =
			limits && typeof limits.fileSize === "number" ? limits.fileSize : Infinity
		const filesLimit =
			limits && typeof limits.files === "number" ? limits.files : Infinity
		const fieldsLimit =
			limits && typeof limits.fields === "number" ? limits.fields : Infinity
		const partsLimit =
			limits && typeof limits.parts === "number" ? limits.parts : Infinity

		let parts = -1 // Account for initial boundary
		let fields = 0
		let files = 0
		let skipPart = false

		this.pendingFiles = 0
		this.fileStream = undefined
		this.complete = false
		let fileSize = 0

		let field: Buffer[] | undefined
		let fieldSize = 0
		let partCharset = defCharset
		let partEncoding = "7bit"
		let partType = "text/plain"
		let partName: string | undefined
		let partTruncated = false

		let hitFilesLimit = false
		let hitFieldsLimit = false

		this.headerParser = null
		const partHeaderParser = new HeaderParser((header) => {
			this.headerParser = null
			skipPart = false

			partType = "text/plain"
			partCharset = defCharset
			partEncoding = "7bit"
			partName = undefined
			partTruncated = false

			let filename
			if (!header["content-disposition"]) {
				skipPart = true
				return
			}

			const disp = parseDisposition(
				header["content-disposition"][0]!,
				paramDecoder,
			)
			if (!disp || disp.type !== "form-data") {
				skipPart = true
				return
			}

			if (disp.params) {
				if (disp.params.name) partName = disp.params.name

				if (disp.params["filename*"]) filename = disp.params["filename*"]
				else if (disp.params.filename) filename = disp.params.filename

				if (filename !== undefined && !preservePath)
					filename = basename(filename)
			}

			if (header["content-type"]) {
				const conType = parseContentType(header["content-type"][0]!)
				if (conType) {
					partType = `${conType.type}/${conType.subtype}`
					if (conType.params && typeof conType.params.charset === "string")
						partCharset = conType.params.charset.toLowerCase()
				}
			}

			if (header["content-transfer-encoding"])
				partEncoding = header["content-transfer-encoding"][0]!.toLowerCase()

			// The S3 file part is binary and streamed even without a filename.
			if (
				partName === "file" ||
				partType === "application/octet-stream" ||
				filename !== undefined
			) {
				// File

				if (files === filesLimit) {
					if (!hitFilesLimit) {
						hitFilesLimit = true
						this.emit("filesLimit")
					}
					skipPart = true
					return
				}
				++files

				if (this.listenerCount("file") === 0) {
					skipPart = true
					return
				}

				fileSize = 0
				this.fileStream = new FileStream(fileOpts, this)
				++this.pendingFiles
				this.emit("file", partName, this.fileStream, {
					filename,
					encoding: partEncoding,
					mimeType: partType,
				})
			} else {
				// Non-file

				if (fields === fieldsLimit) {
					if (!hitFieldsLimit) {
						hitFieldsLimit = true
						this.emit("fieldsLimit")
					}
					skipPart = true
					return
				}
				++fields

				if (this.listenerCount("field") === 0) {
					skipPart = true
					return
				}

				field = []
				fieldSize = 0
			}
		})

		let matchPostBoundary = 0
		const ssCb: MatchCallback = (isMatch, data, start, end, isDataSafe) => {
			if (this.destroyed || this.complete) return
			if (data) {
				retryData: while (start < end) {
					if (this.headerParser !== null) {
						const ret = this.headerParser.push(data, start, end)
						if (ret === -1) {
							this.headerParser = null
							partHeaderParser.reset()
							this.emit("error", new Error("Malformed part header"))
							break
						}
						start = ret
					}

					if (start === end) break

					if (matchPostBoundary !== 0) {
						if (matchPostBoundary === 1) {
							switch (data[start]!) {
								case 45: // '-'
									// Try matching '--' after boundary
									matchPostBoundary = 2
									++start
									break
								case 13: // '\r'
									// Try matching CR LF before header
									matchPostBoundary = 3
									++start
									break
								default:
									matchPostBoundary = 0
							}
							if (start === end) return
						}

						if (matchPostBoundary === 2) {
							matchPostBoundary = 0
							if (data[start] === 45 /* '-' */) {
								// End of multipart data
								this.complete = true
								this.boundaryParser = ignoreData
								return
							}
							// We saw something other than '-', so put the dash we consumed
							// "back"
							const writeCallback = this.writeCallback
							this.writeCallback = noop
							ssCb(false, BUF_DASH, 0, 1, false)
							this.writeCallback = writeCallback
						} else if (matchPostBoundary === 3) {
							matchPostBoundary = 0
							if (data[start] === 10 /* '\n' */) {
								++start
								if (parts >= partsLimit) break
								// Prepare the header parser
								this.headerParser = partHeaderParser
								if (start === end) break
								// Process the remaining data as a header
								continue retryData
							} else {
								// We saw something other than LF, so put the CR we consumed
								// "back"
								const writeCallback = this.writeCallback
								this.writeCallback = noop
								ssCb(false, BUF_CR, 0, 1, false)
								this.writeCallback = writeCallback
							}
						}
					}

					if (!skipPart) {
						if (this.fileStream) {
							let chunk
							const actualLen = Math.min(end - start, fileSizeLimit - fileSize)
							if (!isDataSafe) {
								chunk = Buffer.allocUnsafe(actualLen)
								data.copy(chunk, 0, start, start + actualLen)
							} else {
								chunk = data.slice(start, start + actualLen)
							}

							fileSize += chunk.length
							if (fileSize === fileSizeLimit) {
								if (chunk.length > 0) this.fileStream.push(chunk)
								this.fileStream.emit("limit")
								this.fileStream.truncated = true
								skipPart = true
							} else if (!this.fileStream.push(chunk)) {
								if (this.writeCallback)
									this.fileStream.readCallback = this.writeCallback
								this.writeCallback = null
							}
						} else if (field !== undefined) {
							let chunk
							const actualLen = Math.min(
								end - start,
								fieldSizeLimit - fieldSize,
							)
							if (!isDataSafe) {
								chunk = Buffer.allocUnsafe(actualLen)
								data.copy(chunk, 0, start, start + actualLen)
							} else {
								chunk = data.slice(start, start + actualLen)
							}

							fieldSize += actualLen
							field.push(chunk)
							if (fieldSize === fieldSizeLimit) {
								skipPart = true
								partTruncated = true
							}
						}
					}

					break
				}
			}
			if (isMatch) {
				matchPostBoundary = 1

				if (this.fileStream) {
					// End the active file stream if the previous part was a file
					this.fileStream.push(null)
					this.fileStream = null
				} else if (field !== undefined) {
					let fieldValue
					switch (field.length) {
						case 0:
							fieldValue = ""
							break
						case 1:
							fieldValue = convertToUTF8(field[0]!, partCharset, 0)
							break
						default:
							fieldValue = convertToUTF8(
								Buffer.concat(field, fieldSize),
								partCharset,
								0,
							)
					}
					field = undefined
					fieldSize = 0
					this.emit("field", partName, fieldValue, {
						nameTruncated: false,
						valueTruncated: partTruncated,
						encoding: partEncoding,
						mimeType: partType,
					})
				}

				if (++parts === partsLimit) this.emit("partsLimit")
			}
		}
		this.boundaryParser = new ByteMatcher(`\r\n--${boundary}`, ssCb)

		this.writeCallback = null
		this.finalCallback = null

		// Just in case there is no preamble
		this.write(BUF_CRLF)
	}

	static detect(conType: ContentType) {
		return conType.type === "multipart" && conType.subtype === "form-data"
	}

	_write(chunk: Buffer, enc: BufferEncoding, cb: StreamCallback) {
		this.writeCallback = cb
		this.boundaryParser.push(chunk, 0)
		callAndUnsetCb(this)
	}

	_destroy(err: Error | null, cb: StreamCallback) {
		this.headerParser = null
		this.boundaryParser = ignoreData
		if (!err) err = checkEndState(this) ?? null
		const fileStream = this.fileStream
		if (fileStream) {
			this.fileStream = null
			fileStream.destroy(err ?? undefined)
		}
		cb(err)
	}

	_final(cb: StreamCallback) {
		this.boundaryParser.destroy()
		if (!this.complete) return cb(new Error("Unexpected end of form"))
		if (this.pendingFiles)
			this.finalCallback = finishMultipart.bind(null, this, cb)
		else finishMultipart(this, cb)
	}
}

function finishMultipart(
	self: MultipartParser,
	cb: StreamCallback,
	err?: Error | null,
) {
	if (err) return cb(err)
	err = checkEndState(self)
	cb(err)
}

function checkEndState(self: MultipartParser) {
	if (self.headerParser) return new Error("Malformed part header")
	const fileStream = self.fileStream
	if (fileStream) {
		self.fileStream = null
		fileStream.destroy(new Error("Unexpected end of file"))
	}
	if (!self.complete) return new Error("Unexpected end of form")
	return undefined
}

const TOKEN = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]

const FIELD_VALUE_CHARACTER = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]

/** Parse only multipart/form-data; other form encodings are outside the S3 POST contract. */
export function createMultipartParser(
	headers: Record<string, string>,
): MultipartParser {
	const conType = parseContentType(headers["content-type"] ?? "")
	if (!conType || !MultipartParser.detect(conType))
		throw new Error("Unsupported Content-Type")
	return new MultipartParser({ conType })
}
