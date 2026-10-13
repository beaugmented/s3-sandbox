import { z } from "zod"

/** Stored metadata contains HTTP strings plus filesystem-derived numeric values. */
export type ObjectMetadata = Record<string, string | number | undefined>

export function parseMetadata(json: string): ObjectMetadata {
	const value: unknown = JSON.parse(json)
	return z.record(z.string(), z.union([z.string(), z.number()])).parse(value)
}
