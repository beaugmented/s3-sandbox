import { z } from "zod"

/** Stored metadata contains HTTP strings plus filesystem-derived numeric values. */
export type ObjectMetadata = Record<string, string | number | undefined>

/** Select protocol fields and user metadata, preserving inherited metadata fields. */
export function selectMetadata(
	metadata: ObjectMetadata,
	allowed: readonly string[],
): ObjectMetadata {
	const names = new Set(allowed)
	for (const name in metadata) {
		if (name.startsWith("x-amz-meta-")) names.add(name)
	}
	return Object.fromEntries(
		[...names]
			.filter((name) => name in metadata)
			.map((name) => [name, metadata[name]]),
	)
}

export function parseMetadata(json: string): ObjectMetadata {
	const value: unknown = JSON.parse(json)
	return z.record(z.string(), z.union([z.string(), z.number()])).parse(value)
}
