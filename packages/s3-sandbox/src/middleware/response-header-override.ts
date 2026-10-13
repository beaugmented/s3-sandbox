import isEmpty from "lodash/isEmpty.js"

import S3Error from "../models/error.ts"
import { type S3Context } from "../types.ts"
import { capitalizeHeader } from "../utils.ts"

/**
 * Derived from
 * https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectGET.html#RESTObjectGET-requests-request-parameters
 */
const RESPONSE_HEADERS: Record<string, number> = {
	"response-content-type": 1,
	"response-content-language": 1,
	"response-expires": 1,
	"response-cache-control": 1,
	"response-content-disposition": 1,
	"response-content-encoding": 1,
}

/**
 * Middleware that handles response headers overrides on signed GET requests.
 */
export default () =>
	async function responseHeaderOverride(
		ctx: S3Context,
		next: () => Promise<unknown>,
	) {
		if (ctx.state.website) {
			// skip for static website requests
			return next()
		}

		const overrides = Object.fromEntries<string>(
			Object.entries(ctx.s3Query)
				.filter(([key, value]) => {
					if (!key.startsWith("response-")) return false
					if (!RESPONSE_HEADERS[key]) {
						throw new S3Error(
							"InvalidArgument",
							`${key} is not in the set of overridable response headers. ` +
								"Please refer to the S3 API documentation for a complete list " +
								"of overridable response headers.",
							{
								ArgumentName: key,
								ArgumentValue: value,
							},
						)
					}
					return true
				})
				.map(([key, value]) => [
					capitalizeHeader(key.slice("response-".length)) ?? key,
					value ?? "",
				]),
		)

		switch (ctx.method) {
			case "HEAD":
			case "GET":
				if (!isEmpty(overrides) && !ctx.state.account) {
					throw new S3Error(
						"InvalidRequest",
						"Request specific response headers cannot be used for anonymous " +
							"GET requests.",
					)
				}
				await next()
				ctx.set(overrides)
				break
			default:
				return next()
		}

		return undefined
	}

export { RESPONSE_HEADERS }
