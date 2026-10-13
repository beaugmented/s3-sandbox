import pick from "lodash/pick.js"
import pickBy from "lodash/pickBy.js"

import { type Readable } from "node:stream"
import S3Error from "./error.ts"

class S3Object<
	TContent extends Readable | Buffer | null = Readable | Buffer | null,
> {
	constructor(
		bucket: string,
		key: string,
		content: TContent,
		metadata: Record<string, any>,
	) {
		this.bucket = bucket
		this.key = key
		this.content = content
		if ("x-amz-storage-class" in metadata) {
			if (!S3Object.STORAGE_CLASSES.includes(metadata["x-amz-storage-class"])) {
				throw new S3Error(
					"InvalidStorageClass",
					"The storage class you specified is not valid",
				)
			}
		}
		this.metadata = pick(metadata, [
			...S3Object.ALLOWED_METADATA,

			// intrinsic metadata determined when retrieving objects
			"last-modified",
			"etag",
			"content-length",
		])
		if (!this.metadata["content-type"]) {
			this.metadata["content-type"] = "binary/octet-stream"
		}
		Object.assign(
			this.metadata,
			pickBy(metadata, (v: any, k) => k.startsWith("x-amz-meta-")),
		)
	}

	get size() {
		return Number(this.metadata["content-length"])
	}

	get lastModifiedDate() {
		return new Date(this.metadata["last-modified"])
	}

	declare bucket: string
	declare key: string
	declare content: TContent
	declare metadata: Record<string, any>
	static ALLOWED_METADATA = [
		"cache-control",
		"content-disposition",
		"content-encoding",
		"content-language",
		"content-type",
		"expires",
		"x-amz-storage-class",
		"x-amz-website-redirect-location",
	]
	static STORAGE_CLASSES = [
		"STANDARD",
		"REDUCED_REDUNDANCY",
		"STANDARD_IA",
		"ONEZONE_IA",
		"INTELLIGENT_TIERING",
		"GLACIER",
		"DEEP_ARCHIVE",
		"OUTPOSTS",
	]
	declare range: { start: number; end: number } | undefined
}

export default S3Object
