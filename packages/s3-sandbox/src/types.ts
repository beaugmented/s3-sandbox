import type Koa from "koa"
import type { IncomingMessage } from "node:http"
import type { SandboxLogger } from "./middleware/logger.ts"
import type S3rver from "./s3rver.ts"
import type FilesystemStore from "./stores/filesystem.ts"
import type AWSAccount from "./models/account.ts"
import type { S3WebsiteConfiguration } from "./models/config.ts"
import type { Readable } from "node:stream"
import type { XmlRecord } from "./xml-record.ts"
import type S3Bucket from "./models/bucket.ts"

export type S3State = {
	account?: AWSAccount
	vhost?: boolean
	service?: "s3" | "s3-website"
	website?: Partial<S3WebsiteConfiguration>
	methodIsNotAllowed?: boolean
}
export type S3Context = Koa.ParameterizedContext<
	S3State,
	{ store: FilesystemStore }
> & {
	app: S3rver
	store: FilesystemStore
	bucket?: S3Bucket
	logger: SandboxLogger
	params: { bucket: string; key: string; queryMethod?: string }
	s3Query: Record<string, string>
	s3Headers: Record<string, string>
	request: Koa.Request & {
		body: string | Readable | XmlRecord
		redirect?: (url: string) => void
	}
	req: IncomingMessage & { baseUrl?: string }
	mountPath?: string
}
