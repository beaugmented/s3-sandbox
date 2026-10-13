export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse boundary data without allowing JSON.parse's implicit any to escape. */
export function jsonObject(json: string): Record<string, unknown> {
	const value: unknown = JSON.parse(json)
	if (!isRecord(value)) throw new TypeError("Expected a JSON object")
	return value
}
