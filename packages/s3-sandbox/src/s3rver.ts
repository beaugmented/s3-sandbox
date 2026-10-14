import { protocolHeaders, protocolQuery } from "./protocol-request.ts"
import { Hono, type MiddlewareHandler } from "hono"
import { getRequestListener, type HttpBindings } from "@hono/node-server"
import { EventEmitter } from "node:events"
import { S3HttpContext } from "./http-context.ts"
import { runMiddleware } from "./types.ts"
import http, { type Server, type ServerOptions } from "node:http"
import https, { type ServerOptions as TlsOptions } from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { callbackify } from "node:util"
import loggerMiddleware, { type SandboxLogger } from "./middleware/logger.ts"
import vhostMiddleware from "./middleware/vhost.ts"
import { getConfigModel } from "./models/config.ts"
import route from "./routes.ts"
import FilesystemStore from "./stores/filesystem.ts"
import type { S3Context } from "./types.ts"
import * as xmlParser from "./xml.ts"

export type BucketConfiguration = {
	name: string
	configs?: Array<string | Buffer>
}
export type S3SandboxOptions = ServerOptions &
	TlsOptions & {
		address?: string
		port?: number
		silent?: boolean
		serviceEndpoint?: string
		directory?: string
		resetOnClose?: boolean
		allowMismatchedSignatures?: boolean
		vhostBuckets?: boolean
		configureBuckets?: BucketConfiguration[]
	}
type Defaults = Required<
	Pick<
		S3SandboxOptions,
		| "address"
		| "port"
		| "silent"
		| "serviceEndpoint"
		| "directory"
		| "resetOnClose"
		| "allowMismatchedSignatures"
		| "vhostBuckets"
		| "configureBuckets"
	>
>
export type RunCallback = (error: Error | null, address?: AddressInfo) => void
export type CloseCallback = (error: Error | null) => void

/** A local S3-compatible server backed by Hono and a filesystem store. */
export default class S3Sandbox extends EventEmitter {
	static defaultOptions: Defaults = {
		address: "localhost",
		port: 4568,
		silent: false,
		serviceEndpoint: "amazonaws.com",
		directory: path.join(os.tmpdir(), "s3-sandbox"),
		resetOnClose: false,
		allowMismatchedSignatures: false,
		vhostBuckets: true,
		configureBuckets: [],
	}
	declare logger: SandboxLogger
	readonly silent: boolean
	private readonly application = new Hono<{
		Bindings: HttpBindings & { mountPath?: string }
		Variables: { s3: S3Context }
	}>()
	readonly store: FilesystemStore
	readonly serverOptions: S3SandboxOptions & { address: string; port: number }
	readonly resetOnClose: boolean
	readonly allowMismatchedSignatures: boolean
	private buckets: BucketConfiguration[]
	httpServer: Server | undefined
	private starting = false

	constructor(options: S3SandboxOptions = {}) {
		super()
		const {
			silent,
			serviceEndpoint,
			directory,
			resetOnClose,
			allowMismatchedSignatures,
			vhostBuckets,
			configureBuckets,
			...serverOptions
		} = {
			...options,
			address:
				options.address === undefined
					? S3Sandbox.defaultOptions.address
					: options.address,
			port:
				options.port === undefined
					? S3Sandbox.defaultOptions.port
					: options.port,
			silent:
				options.silent === undefined
					? S3Sandbox.defaultOptions.silent
					: options.silent,
			serviceEndpoint:
				options.serviceEndpoint === undefined
					? S3Sandbox.defaultOptions.serviceEndpoint
					: options.serviceEndpoint,
			directory:
				options.directory === undefined
					? S3Sandbox.defaultOptions.directory
					: options.directory,
			resetOnClose:
				options.resetOnClose === undefined
					? S3Sandbox.defaultOptions.resetOnClose
					: options.resetOnClose,
			allowMismatchedSignatures:
				options.allowMismatchedSignatures === undefined
					? S3Sandbox.defaultOptions.allowMismatchedSignatures
					: options.allowMismatchedSignatures,
			vhostBuckets:
				options.vhostBuckets === undefined
					? S3Sandbox.defaultOptions.vhostBuckets
					: options.vhostBuckets,
			configureBuckets:
				options.configureBuckets === undefined
					? S3Sandbox.defaultOptions.configureBuckets
					: options.configureBuckets,
		}
		this.silent = silent
		this.serverOptions = serverOptions
		this.buckets = configureBuckets
		this.resetOnClose = resetOnClose
		this.allowMismatchedSignatures = allowMismatchedSignatures
		this.store = new FilesystemStore(directory)
		const logger = loggerMiddleware(this, silent)
		const vhost = vhostMiddleware({ serviceEndpoint, vhostBuckets })
		this.on("error", (error: Error) => this.logger.error(error.message))
		this.application.use("*", async (context, next) => {
			const ctx = new S3HttpContext(
				this,
				context.env.incoming,
				context.env.mountPath,
			)
			context.set("s3", ctx)
			ctx.s3Headers = protocolHeaders(ctx.headers)
			ctx.s3Query = protocolQuery(ctx.query)
			await runMiddleware(ctx, [
				logger,
				vhost,
				async () => {
					await next()
				},
			])
		})
		this.application.all("*", async (context) => {
			const ctx = context.get("s3")
			await route(ctx)
			return ctx.toResponse()
		})
		this.application.onError(async (error, context) => {
			const ctx = context.get("s3")
			await ctx.handleError(error)
			return ctx.toResponse()
		})
	}

	async configureBuckets(): Promise<void> {
		await Promise.all(
			this.buckets.map(async (bucket) => {
				const existed = Boolean(await this.store.getBucket(bucket.name))
				await this.store.putBucket(bucket.name)
				const replaced: string[] = []
				for (const input of bucket.configs ?? []) {
					const xml = input.toString()
					const tag = xmlParser.getRootTag(xml)
					const Model =
						tag === "CORSConfiguration"
							? getConfigModel("cors")
							: tag === "WebsiteConfiguration"
								? getConfigModel("website")
								: undefined
					if (!Model)
						throw new Error(
							"error reading bucket config: unsupported configuration type",
						)
					const config = Model.validate(xml)
					if (
						// oxlint-disable-next-line eslint/no-await-in-loop -- Apply duplicate bucket configurations in caller-provided order.
						await this.store.getSubresource(bucket.name, undefined, config.type)
					)
						replaced.push(config.type)
					// oxlint-disable-next-line eslint/no-await-in-loop -- Each configuration replaces the previous configuration of that type.
					await this.store.putSubresource(bucket.name, undefined, config)
				}
				if (replaced.length)
					this.logger.warn(
						'replaced %s config for bucket "%s"',
						replaced.join(),
						bucket.name,
					)
				else if (existed)
					this.logger.warn('the bucket "%s" already exists', bucket.name)
			}),
		)
	}

	reset(): void {
		this.store.reset()
	}
	callback(): ReturnType<typeof getRequestListener> {
		return getRequestListener(this.application.fetch, {
			overrideGlobalObjects: false,
		})
	}
	getMiddleware() {
		return this.callback()
	}
	/** Mount in a Hono app using its Node adapter, preserving raw paths for signing. */
	getHonoMiddleware(
		mountPath = "",
	): MiddlewareHandler<{ Bindings: HttpBindings }> {
		if (
			mountPath &&
			(!mountPath.startsWith("/") ||
				mountPath.endsWith("/") ||
				/[?#]/u.test(mountPath))
		)
			throw new TypeError(
				"Mount path must start with / and have no trailing /, query, or fragment",
			)
		return async (context, next) => {
			const rawPath = (context.env.incoming.url ?? "/").split("?")[0] ?? "/"
			if (
				mountPath &&
				rawPath !== mountPath &&
				!rawPath.startsWith(mountPath + "/")
			)
				return next()
			return this.application.fetch(context.req.raw, {
				...context.env,
				mountPath,
			})
		}
	}

	run(): Promise<AddressInfo>
	run(callback: RunCallback): this
	run(callback?: RunCallback): this | Promise<AddressInfo> {
		const start = async (): Promise<AddressInfo> => {
			if (this.starting || this.httpServer?.listening)
				throw new Error("Already running")
			this.starting = true
			try {
				await this.configureBuckets()
				const { address, port, key, cert, pfx } = this.serverOptions
				const handleRequest = this.callback()
				const listener: http.RequestListener = (req, res) => {
					// The Node adapter owns response completion and handles rejected requests.
					void handleRequest(req, res).catch((error: unknown) => {
						const failure =
							error instanceof Error ? error : new Error(String(error))
						this.emit("error", failure)
						res.destroy(failure)
					})
				}
				const server =
					(key && cert) || pfx
						? https.createServer(this.serverOptions, listener)
						: http.createServer(this.serverOptions, listener)
				server.once("close", () => {
					if (this.resetOnClose) this.reset()
				})
				await new Promise<void>((resolve, reject) => {
					const onError = (error: Error) => reject(error)
					server.once("error", onError)
					server.listen({ port, host: address }, () => {
						server.off("error", onError)
						resolve()
					})
				})
				this.httpServer = server
				const boundAddress = server.address()
				if (boundAddress === null || typeof boundAddress === "string")
					throw new Error("Expected a TCP server address")
				return boundAddress
			} finally {
				this.starting = false
			}
		}
		if (callback) {
			callbackify(start)(callback)
			return this
		}
		return start()
	}

	close(): Promise<void>
	close(callback: CloseCallback): this
	close(callback?: CloseCallback): this | Promise<void> {
		const stop = async (): Promise<void> => {
			if (!this.httpServer) throw new Error("Not running")
			const server = this.httpServer
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
			this.httpServer = undefined
		}
		if (callback) {
			callbackify(stop)(callback)
			return this
		}
		return stop()
	}
}
