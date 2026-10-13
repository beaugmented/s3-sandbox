import type { IncomingHttpHeaders } from "node:http"
import type { ParsedUrlQuery } from "node:querystring"
import S3Error from "./models/error.ts"

/** Normalize HTTP's multi-value representation without mutating the Node request. */
export function protocolHeaders(
	headers: IncomingHttpHeaders,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).flatMap(([name, value]) =>
			value === undefined
				? []
				: [[name, Array.isArray(value) ? value.join(",") : value]],
		),
	)
}

/** Each S3 operation/signing parameter represents one value. Reject ambiguous repeats. */
export function protocolQuery(query: ParsedUrlQuery): Record<string, string> {
	const entries: Array<[string, string]> = []
	for (const [name, value] of Object.entries(query)) {
		if (typeof value !== "string")
			throw new S3Error(
				"InvalidArgument",
				"Query string parameters must have a single value",
				{ ArgumentName: name, ArgumentValue: value },
			)
		entries.push([name, value])
	}
	return Object.fromEntries(entries)
}
