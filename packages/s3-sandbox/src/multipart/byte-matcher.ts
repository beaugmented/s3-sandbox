/** Adapted from Brian White's MIT-licensed implementation; see LICENSES/busboy-MIT.txt. */

/*
  Based heavily on the Streaming Boyer-Moore-Horspool C++ implementation
  by Hongli Lai at: https://github.com/FooBarWidget/boyer-moore-horspool
*/
function memcmp(
	buf1: Buffer,
	pos1: number,
	buf2: Buffer,
	pos2: number,
	num: number,
) {
	for (let i = 0; i < num; ++i) {
		if (buf1[pos1 + i] !== buf2[pos2 + i]!) return false
	}
	return true
}

export type MatchCallback = (
	matched: boolean,
	data: Buffer | undefined,
	start: number,
	end: number,
	safe: boolean,
) => void
export default class ByteMatcher {
	declare maxMatches: number
	declare matches: number
	declare callback: MatchCallback
	declare lookbehindSize: number
	declare needle: Buffer
	declare bufferPosition: number
	declare lookbehind: Buffer
	declare occurrences: Uint32Array

	constructor(needle: string | Buffer, cb: MatchCallback) {
		if (typeof cb !== "function") throw new Error("Missing match callback")

		if (typeof needle === "string") needle = Buffer.from(needle)
		else if (!Buffer.isBuffer(needle))
			throw new Error(`Expected Buffer for needle, got ${typeof needle}`)

		const needleLen = needle.length

		this.maxMatches = Infinity
		this.matches = 0

		this.callback = cb
		this.lookbehindSize = 0
		this.needle = needle
		this.bufferPosition = 0

		this.lookbehind = Buffer.allocUnsafe(needleLen)

		// Initialize occurrence table.
		this.occurrences = new Uint32Array(256).fill(needleLen)

		// Populate occurrence table with analysis of the needle, ignoring the last
		// letter.
		if (needleLen > 1) {
			for (let i = 0; i < needleLen - 1; ++i)
				this.occurrences[needle[i]!] = needleLen - 1 - i
		}
	}

	reset() {
		this.matches = 0
		this.lookbehindSize = 0
		this.bufferPosition = 0
	}

	push(chunk: Buffer, pos: number) {
		let result
		const chunkLen = chunk.length
		this.bufferPosition = pos || 0
		while (result !== chunkLen && this.matches < this.maxMatches)
			result = feed(this, chunk)
		return result
	}

	destroy() {
		const lbSize = this.lookbehindSize
		if (lbSize) this.callback(false, this.lookbehind, 0, lbSize, false)
		this.reset()
	}
}

function feed(self: ByteMatcher, data: Buffer) {
	const len = data.length
	const needle = self.needle
	const needleLen = needle.length

	// Positive: points to a position in `data`
	//           pos == 3 points to data[3]
	// Negative: points to a position in the lookbehind buffer
	//           pos == -2 points to lookbehind[lookbehindSize - 2]
	let pos = -self.lookbehindSize
	const lastNeedleCharPos = needleLen - 1
	const lastNeedleChar = needle[lastNeedleCharPos]!
	const end = len - needleLen
	const occ = self.occurrences
	const lookbehind = self.lookbehind

	if (pos < 0) {
		// Lookbehind buffer is not empty. Perform Boyer-Moore-Horspool
		// search with character lookup code that considers both the
		// lookbehind buffer and the current round's haystack data.
		//
		// Loop until
		//   there is a match.
		// or until
		//   we've moved past the position that requires the
		//   lookbehind buffer. In this case we switch to the
		//   optimized loop.
		// or until
		//   the character to look at lies outside the haystack.
		while (pos < 0 && pos <= end) {
			const nextPos = pos + lastNeedleCharPos
			const ch =
				nextPos < 0
					? lookbehind[self.lookbehindSize + nextPos]!
					: data[nextPos]!

			if (
				ch === lastNeedleChar &&
				matchNeedle(self, data, pos, lastNeedleCharPos)
			) {
				self.lookbehindSize = 0
				++self.matches
				if (pos > -self.lookbehindSize)
					self.callback(true, lookbehind, 0, self.lookbehindSize + pos, false)
				else self.callback(true, undefined, 0, 0, true)

				return (self.bufferPosition = pos + needleLen)
			}

			pos += occ[ch]!
		}

		// No match.

		// There's too few data for Boyer-Moore-Horspool to run,
		// so let's use a different algorithm to skip as much as
		// we can.
		// Forward pos until
		//   the trailing part of lookbehind + data
		//   looks like the beginning of the needle
		// or until
		//   pos == 0
		while (pos < 0 && !matchNeedle(self, data, pos, len - pos)) ++pos

		if (pos < 0) {
			// Cut off part of the lookbehind buffer that has
			// been processed and append the entire haystack
			// into it.
			const bytesToCutOff = self.lookbehindSize + pos

			if (bytesToCutOff > 0) {
				// The cut off data is guaranteed not to contain the needle.
				self.callback(false, lookbehind, 0, bytesToCutOff, false)
			}

			self.lookbehindSize -= bytesToCutOff
			lookbehind.copy(lookbehind, 0, bytesToCutOff, self.lookbehindSize)
			lookbehind.set(data, self.lookbehindSize)
			self.lookbehindSize += len

			self.bufferPosition = len
			return len
		}

		// Discard lookbehind buffer.
		self.callback(false, lookbehind, 0, self.lookbehindSize, false)
		self.lookbehindSize = 0
	}

	pos += self.bufferPosition

	const firstNeedleChar = needle[0]!

	// Lookbehind buffer is now empty. Perform Boyer-Moore-Horspool
	// search with optimized character lookup code that only considers
	// the current round's haystack data.
	while (pos <= end) {
		const ch = data[pos + lastNeedleCharPos]!

		if (
			ch === lastNeedleChar &&
			data[pos] === firstNeedleChar &&
			memcmp(needle, 0, data, pos, lastNeedleCharPos)
		) {
			++self.matches
			if (pos > 0) self.callback(true, data, self.bufferPosition, pos, true)
			else self.callback(true, undefined, 0, 0, true)

			return (self.bufferPosition = pos + needleLen)
		}

		pos += occ[ch]!
	}

	// There was no match. If there's trailing haystack data that we cannot
	// match yet using the Boyer-Moore-Horspool algorithm (because the trailing
	// data is less than the needle size) then match using a modified
	// algorithm that starts matching from the beginning instead of the end.
	// Whatever trailing data is left after running this algorithm is added to
	// the lookbehind buffer.
	while (pos < len) {
		if (
			data[pos] !== firstNeedleChar ||
			!memcmp(data, pos, needle, 0, len - pos)
		) {
			++pos
			continue
		}
		data.copy(lookbehind, 0, pos, len)
		self.lookbehindSize = len - pos
		break
	}

	// Everything until `pos` is guaranteed not to contain needle data.
	if (pos > 0)
		self.callback(false, data, self.bufferPosition, pos < len ? pos : len, true)

	self.bufferPosition = len
	return len
}

function matchNeedle(
	self: ByteMatcher,
	data: Buffer,
	pos: number,
	len: number,
) {
	const lb = self.lookbehind
	const lbSize = self.lookbehindSize
	const needle = self.needle

	for (let i = 0; i < len; ++i, ++pos) {
		const ch = pos < 0 ? lb[lbSize + pos]! : data[pos]!
		if (ch !== needle[i]!) return false
	}
	return true
}
