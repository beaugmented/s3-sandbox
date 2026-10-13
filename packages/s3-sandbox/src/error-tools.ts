/** Thrown values are untrusted; preserve actual errors and normalize other values. */
export function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value))
}

export function hasErrorCode(value: unknown, code: string): boolean {
	return value instanceof Error && "code" in value && value.code === code
}
