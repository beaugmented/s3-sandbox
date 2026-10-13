import type Koa from "koa"
import type { IncomingMessage } from "node:http"
import type { SandboxLogger } from "./middleware/logger.ts"
import type S3rver from "./s3rver.ts"
import type FilesystemStore from "./stores/filesystem.ts"

/** XML and HTTP wire records are validated by the corresponding protocol handlers. */
export type WireRecord = Record<string, any>
export type S3Context = Koa.Context & {
	app: S3rver
	store: FilesystemStore
	logger: SandboxLogger
	params: { bucket: string; key: string; queryMethod?: string }
	query: WireRecord
	headers: Record<string, string>
	state: WireRecord
	request: Koa.Request & WireRecord
	req: IncomingMessage & { baseUrl?: string }
	mountPath?: string
}
