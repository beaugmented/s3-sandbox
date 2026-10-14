/** Adapted from Brian White's MIT-licensed implementation; see LICENSES/busboy-MIT.txt. */
type Parameters = Record<string, string>
export type Decoder = (
	data: Buffer | string,
	hint: number,
) => string | undefined
export type ParameterDecoder = (
	data: string,
	hint: number,
) => string | undefined

export function parseContentType(str: string) {
	if (str.length === 0) return undefined

	const params: Parameters = {}
	Object.setPrototypeOf(params, null)
	let i = 0

	// Parse type
	for (; i < str.length; ++i) {
		const code = str.charCodeAt(i)
		if (TOKEN[code] !== 1) {
			if (code !== 47 /* '/' */ || i === 0) return undefined
			break
		}
	}
	// Check for type without subtype
	if (i === str.length) return undefined

	const type = str.slice(0, i).toLowerCase()

	// Parse subtype
	const subtypeStart = ++i
	for (; i < str.length; ++i) {
		const code = str.charCodeAt(i)
		if (TOKEN[code] !== 1) {
			// Make sure we have a subtype
			if (i === subtypeStart) return undefined

			if (parseContentTypeParams(str, i, params) === undefined) return undefined
			break
		}
	}
	// Make sure we have a subtype
	if (i === subtypeStart) return undefined

	const subtype = str.slice(subtypeStart, i).toLowerCase()

	return { type, subtype, params }
}

function parseContentTypeParams(str: string, i: number, params: Parameters) {
	while (i < str.length) {
		// Consume whitespace
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (code !== 32 /* ' ' */ && code !== 9 /* '\t' */) break
		}

		// Ended on whitespace
		if (i === str.length) break

		// Check for malformed parameter
		if (str.charCodeAt(i++) !== 59 /* ';' */) return undefined

		// Consume whitespace
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (code !== 32 /* ' ' */ && code !== 9 /* '\t' */) break
		}

		// Ended on whitespace (malformed)
		if (i === str.length) return undefined

		let name
		const nameStart = i
		// Parse parameter name
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (TOKEN[code] !== 1) {
				if (code !== 61 /* '=' */) return undefined
				break
			}
		}

		// No value (malformed)
		if (i === str.length) return undefined

		name = str.slice(nameStart, i)
		++i // Skip over '='

		// No value (malformed)
		if (i === str.length) return undefined

		let value: string | undefined = ""
		let valueStart
		if (str.charCodeAt(i) === 34 /* '"' */) {
			valueStart = ++i
			let escaping = false
			// Parse quoted value
			for (; i < str.length; ++i) {
				const code = str.charCodeAt(i)
				if (code === 92 /* '\\' */) {
					if (escaping) {
						valueStart = i
						escaping = false
					} else {
						value += str.slice(valueStart, i)
						escaping = true
					}
					continue
				}
				if (code === 34 /* '"' */) {
					if (escaping) {
						valueStart = i
						escaping = false
						continue
					}
					value += str.slice(valueStart, i)
					break
				}
				if (escaping) {
					valueStart = i - 1
					escaping = false
				}
				// Invalid unescaped quoted character (malformed)
				if (QUOTED_TEXT[code] !== 1) return undefined
			}

			// No end quote (malformed)
			if (i === str.length) return undefined

			++i // Skip over double quote
		} else {
			valueStart = i
			// Parse unquoted value
			for (; i < str.length; ++i) {
				const code = str.charCodeAt(i)
				if (TOKEN[code] !== 1) {
					// No value (malformed)
					if (i === valueStart) return undefined
					break
				}
			}
			value = str.slice(valueStart, i)
		}

		name = name.toLowerCase()
		if (params[name] === undefined) params[name] = value
	}

	return params
}

export function parseDisposition(str: string, defDecoder: ParameterDecoder) {
	if (str.length === 0) return undefined

	const params: Parameters = {}
	Object.setPrototypeOf(params, null)
	let i = 0

	for (; i < str.length; ++i) {
		const code = str.charCodeAt(i)
		if (TOKEN[code] !== 1) {
			if (parseDispositionParams(str, i, params, defDecoder) === undefined)
				return undefined
			break
		}
	}

	const type = str.slice(0, i).toLowerCase()

	return { type, params }
}

function parseDispositionParams(
	str: string,
	i: number,
	params: Parameters,
	defDecoder: ParameterDecoder,
) {
	while (i < str.length) {
		// Consume whitespace
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (code !== 32 /* ' ' */ && code !== 9 /* '\t' */) break
		}

		// Ended on whitespace
		if (i === str.length) break

		// Check for malformed parameter
		if (str.charCodeAt(i++) !== 59 /* ';' */) return undefined

		// Consume whitespace
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (code !== 32 /* ' ' */ && code !== 9 /* '\t' */) break
		}

		// Ended on whitespace (malformed)
		if (i === str.length) return undefined

		let name
		const nameStart = i
		// Parse parameter name
		for (; i < str.length; ++i) {
			const code = str.charCodeAt(i)
			if (TOKEN[code] !== 1) {
				if (code === 61 /* '=' */) break
				return undefined
			}
		}

		// No value (malformed)
		if (i === str.length) return undefined

		let value: string | undefined = ""
		let valueStart
		let charset
		//~ let lang;
		name = str.slice(nameStart, i)
		if (name.charCodeAt(name.length - 1) === 42 /* '*' */) {
			// Extended value

			const charsetStart = ++i
			// Parse charset name
			for (; i < str.length; ++i) {
				const code = str.charCodeAt(i)
				if (CHARSET[code] !== 1) {
					if (code !== 39 /* '\'' */) return undefined
					break
				}
			}

			// Incomplete charset (malformed)
			if (i === str.length) return undefined

			charset = str.slice(charsetStart, i)
			++i // Skip over the '\''

			//~ const langStart = ++i;
			// Parse language name
			for (; i < str.length; ++i) {
				const code = str.charCodeAt(i)
				if (code === 39 /* '\'' */) break
			}

			// Incomplete language (malformed)
			if (i === str.length) return undefined

			//~ lang = str.slice(langStart, i);
			++i // Skip over the '\''

			// No value (malformed)
			if (i === str.length) return undefined

			valueStart = i

			let encode = 0
			// Parse value
			for (; i < str.length; ++i) {
				const code = str.charCodeAt(i)
				if (EXTENDED_VALUE[code] !== 1) {
					if (code === 37 /* '%' */) {
						let hexUpper: number | undefined
						let hexLower: number | undefined
						if (
							i + 2 < str.length &&
							(hexUpper = HEX_VALUES[str.charCodeAt(i + 1)] ?? -1) !== -1 &&
							(hexLower = HEX_VALUES[str.charCodeAt(i + 2)] ?? -1) !== -1
						) {
							const byteVal = (hexUpper << 4) + hexLower
							value += str.slice(valueStart, i)
							value += String.fromCharCode(byteVal)
							i += 2
							valueStart = i + 1
							if (byteVal >= 128) encode = 2
							else if (encode === 0) encode = 1
							continue
						}
						// '%' disallowed in non-percent encoded contexts (malformed)
						return undefined
					}
					break
				}
			}

			value += str.slice(valueStart, i)
			value = convertToUTF8(value, charset, encode)
			if (value === undefined) return undefined
		} else {
			// Non-extended value

			++i // Skip over '='

			// No value (malformed)
			if (i === str.length) return undefined

			if (str.charCodeAt(i) === 34 /* '"' */) {
				valueStart = ++i
				let escaping = false
				// Parse quoted value
				for (; i < str.length; ++i) {
					const code = str.charCodeAt(i)
					if (code === 92 /* '\\' */) {
						if (escaping) {
							valueStart = i
							escaping = false
						} else {
							value += str.slice(valueStart, i)
							escaping = true
						}
						continue
					}
					if (code === 34 /* '"' */) {
						if (escaping) {
							valueStart = i
							escaping = false
							continue
						}
						value += str.slice(valueStart, i)
						break
					}
					if (escaping) {
						valueStart = i - 1
						escaping = false
					}
					// Invalid unescaped quoted character (malformed)
					if (QUOTED_TEXT[code] !== 1) return undefined
				}

				// No end quote (malformed)
				if (i === str.length) return undefined

				++i // Skip over double quote
			} else {
				valueStart = i
				// Parse unquoted value
				for (; i < str.length; ++i) {
					const code = str.charCodeAt(i)
					if (TOKEN[code] !== 1) {
						// No value (malformed)
						if (i === valueStart) return undefined
						break
					}
				}
				value = str.slice(valueStart, i)
			}

			value = defDecoder(value, 2)
			if (value === undefined) return undefined
		}

		name = name.toLowerCase()
		if (params[name] === undefined) params[name] = value
	}

	return params
}

export function getDecoder(charset: string): Decoder {
	const name = charset.toLowerCase()
	const aliases: Record<string, BufferEncoding> = {
		"utf-8": "utf8",
		utf8: "utf8",
		latin1: "latin1",
		ascii: "latin1",
		"us-ascii": "latin1",
		"iso-8859-1": "latin1",
		"iso8859-1": "latin1",
		iso88591: "latin1",
		"iso_8859-1": "latin1",
		"windows-1252": "latin1",
		"iso_8859-1:1987": "latin1",
		cp1252: "latin1",
		"x-cp1252": "latin1",
		utf16le: "utf16le",
		"utf-16le": "utf16le",
		ucs2: "utf16le",
		"ucs-2": "utf16le",
		base64: "base64",
	}
	return (data, hint) => {
		if (data.length === 0) return ""
		const encoding = Object.hasOwn(aliases, name) ? aliases[name] : undefined
		if (
			typeof data === "string" &&
			(encoding === "latin1" || (encoding === "utf8" && hint < 2))
		)
			return data
		const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data
		if (encoding) return bytes.toString(encoding)
		try {
			return new TextDecoder(name).decode(bytes)
		} catch {
			return undefined
		}
	}
}

export function convertToUTF8(
	data: Buffer | string,
	charset: string,
	hint: number,
) {
	const decode = getDecoder(charset)
	return decode(data, hint)
}

export function basename(path: string) {
	if (typeof path !== "string") return ""
	for (let i = path.length - 1; i >= 0; --i) {
		switch (path.charCodeAt(i)) {
			case 0x2f: // '/'
			case 0x5c: // '\'
				path = path.slice(i + 1)
				return path === ".." || path === "." ? "" : path
		}
	}
	return path === ".." || path === "." ? "" : path
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

const QUOTED_TEXT = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]

const CHARSET = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]

const EXTENDED_VALUE = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]

const HEX_VALUES = [
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1, -1,
	-1, -1, -1, -1, -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10,
	11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1,
]
