import { format } from "node:util"
import { Logger } from "takua"
import type S3rver from "../s3rver.ts"
import type { S3Context } from "../types.ts"

export class SandboxLogger {
	private logger: Logger
	private silent: boolean
	constructor(silent: boolean) {
		this.silent = silent
		this.logger = new Logger({ colorEnabled: process.stdout.isTTY ?? false })
	}
	info(message: string, ...args: unknown[]) {
		if (!this.silent) this.logger.info("s3-sandbox", format(message, ...args))
	}
	warn(message: string, ...args: unknown[]) {
		if (!this.silent) this.logger.warn("s3-sandbox", format(message, ...args))
	}
	error(message: string, ...args: unknown[]) {
		if (!this.silent) this.logger.error("s3-sandbox", format(message, ...args))
	}
	debug(message: string, ...args: unknown[]) {
		this.info(message, ...args)
	}
}

export default function loggerMiddleware(app: S3rver, silent: boolean) {
	app.logger = app.context.logger = new SandboxLogger(silent)
	return async (ctx: S3Context, next: () => Promise<unknown>) => {
		const start = performance.now()
		try {
			await next()
		} finally {
			app.logger.info(
				"%s %s %d %dms",
				ctx.method,
				ctx.url,
				ctx.status,
				Math.round(performance.now() - start),
			)
		}
	}
}
