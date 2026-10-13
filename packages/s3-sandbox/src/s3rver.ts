import { protocolHeaders, protocolQuery } from "./protocol-request.ts"
import defaults from "lodash/defaults.js"
import isPlainObject from "lodash/isPlainObject.js"
import * as he from "he"
import Koa from "koa"
import http, { type Server, type ServerOptions } from "node:http"
import https, { type ServerOptions as TlsOptions } from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { callbackify, format } from "node:util"
import loggerMiddleware, { type SandboxLogger } from "./middleware/logger.ts"
import vhostMiddleware from "./middleware/vhost.ts"
import { getConfigModel } from "./models/config.ts"
import S3Error from "./models/error.ts"
import router from "./routes.ts"
import FilesystemStore from "./stores/filesystem.ts"
import type { S3Context, S3State } from "./types.ts"
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

/** A local S3-compatible Koa application with a filesystem store. */
export default class S3Sandbox extends Koa<S3State, S3Context> {
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
	readonly store: FilesystemStore
	readonly serverOptions: S3SandboxOptions & { address: string; port: number }
	readonly resetOnClose: boolean
	readonly allowMismatchedSignatures: boolean
	private buckets: BucketConfiguration[]
	httpServer: Server | undefined
	private starting = false

	constructor(options: S3SandboxOptions = {}) {
		super()
		// oxlint-disable-next-line unicorn/prefer-add-event-listener -- Koa exposes an error hook, not a DOM event.
		this.context.onerror = onerror
		const {
			silent,
			serviceEndpoint,
			directory,
			resetOnClose,
			allowMismatchedSignatures,
			vhostBuckets,
			configureBuckets,
			...serverOptions
		} = defaults({}, options, S3Sandbox.defaultOptions) as S3SandboxOptions &
			Defaults
		this.silent = silent
		this.serverOptions = serverOptions
		this.buckets = configureBuckets
		this.resetOnClose = resetOnClose
		this.allowMismatchedSignatures = allowMismatchedSignatures
		this.store = this.context.store = new FilesystemStore(directory)
		this.use(loggerMiddleware(this, silent))
		const builder = new xmlParser.j2xParser({
			ignoreAttributes: false,
			attrNodeName: "@",
			tagValueProcessor: (value) => he.escape(value),
		})
		this.use(async (ctx: S3Context, next: () => Promise<unknown>) => {
			await next()
			if (isPlainObject(ctx.body)) {
				ctx.type = "application/xml"
				ctx.body =
					'<?xml version="1.0" encoding="UTF-8"?>\n' + builder.parse(ctx.body)
			}
		})
		this.use((ctx: S3Context, next: () => Promise<unknown>) => {
			ctx.mountPath = ctx.mountPath || ctx.req.baseUrl || ""
			ctx.s3Headers = protocolHeaders(ctx.headers)
			ctx.s3Query = protocolQuery(ctx.query)
			return next()
		})
		this.use(vhostMiddleware({ serviceEndpoint, vhostBuckets }))
		this.use(router.routes())
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
	getMiddleware() {
		return this.callback()
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
					// Koa catches middleware rejections and owns response completion.
					void handleRequest(req, res)
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

function onerror(this: S3Context, input: unknown): void {
	if (input == null) return
	const error =
		input instanceof Error
			? input
			: new Error(format("non-error thrown: %j", input))
	const sent = this.headerSent || !this.writable
	if (sent) Object.assign(error, { headerSent: true })
	this.app.emit("error", error, this)
	if (sent) return
	const s3Error = error instanceof S3Error ? error : S3Error.fromError(error)
	this.res
		.getHeaderNames()
		.filter((name) => !/^access-control-|vary|x-amz-/i.test(name))
		.forEach((name) => this.res.removeHeader(name))
	const body = s3Error.toXML()
	this.type = "application/xml"
	this.status = s3Error.status
	this.length = Buffer.byteLength(body)
	this.res.end(body)
}
