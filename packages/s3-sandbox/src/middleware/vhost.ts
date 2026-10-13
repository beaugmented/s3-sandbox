import escapeRegExp from "lodash/escapeRegExp.js"
import { isIP } from "node:net"
import { hostname } from "node:os"
import { type S3Context } from "../types.ts"

/**
 * Middleware that rewrites URLs for buckets specified via subdomain or host header
 */
export default ({
	serviceEndpoint,
	vhostBuckets,
}: {
	serviceEndpoint: string
	vhostBuckets: boolean
}) =>
	function vhost(ctx: S3Context, next: () => Promise<unknown>) {
		const pattern = RegExp(
			`^(?:(.+)\\.)?s3(-website)?([-.].+)?\\.${escapeRegExp(serviceEndpoint)}$`,
		)
		const [match, bucket, website] = pattern.exec(ctx.hostname) || []
		ctx.state.vhost = Boolean(bucket)
		if (match) {
			ctx.state.service = website ? "s3-website" : "s3"
			if (bucket) {
				// Rewrite path for requests to <bucket>.s3[-website][-<region>].amazonaws.com
				ctx.path = `/${bucket}${ctx.path}`
			}
		} else {
			// if the request contains any x-amz-* headers or query string parameters,
			// consider this an SDK/CLI request
			for (const key of [
				...Object.keys(ctx.s3Headers),
				...Object.keys(ctx.s3Query),
			]) {
				if (key.toLowerCase().startsWith("x-amz-")) {
					ctx.state.service = "s3"
					break
				}
			}
			if (
				vhostBuckets &&
				!isIP(ctx.hostname) &&
				!["localhost", hostname()].includes(ctx.hostname)
			) {
				ctx.state.vhost = true
				// otherwise attempt to distinguish virtual host-style requests
				ctx.path = `/${ctx.hostname}${ctx.path}`
			}
		}
		return next()
	}
