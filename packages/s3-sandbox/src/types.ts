import type AWSAccount from "./models/account.ts"
import type { S3WebsiteConfiguration } from "./models/config.ts"
import type { S3HttpContext } from "./http-context.ts"

export type S3State = {
	account?: AWSAccount
	vhost?: boolean
	service?: "s3" | "s3-website"
	website?: Partial<S3WebsiteConfiguration>
	methodIsNotAllowed?: boolean
}
export type S3Context = S3HttpContext
export type S3Middleware = (
	ctx: S3Context,
	next: () => Promise<unknown>,
) => unknown

export async function runMiddleware(
	ctx: S3Context,
	handlers: readonly S3Middleware[],
): Promise<void> {
	let previous = -1
	async function dispatch(index: number): Promise<void> {
		if (index <= previous)
			throw new Error("Middleware called next more than once")
		previous = index
		await handlers[index]?.(ctx, () => dispatch(index + 1))
	}
	await dispatch(0)
}
