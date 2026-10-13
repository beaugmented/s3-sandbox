import type { ObjectMetadata } from "../metadata.ts"
import { parseDate } from "../temporal-tools.ts"
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
		metadata: ObjectMetadata,
	) {
		this.bucket = bucket
		this.key = key
		this.content = content
		if ("x-amz-storage-class" in metadata) {
			if (
				!S3Object.STORAGE_CLASSES.includes(
					String(metadata["x-amz-storage-class"]),
				)
			) {
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
			pickBy(metadata, (_value, name) => name.startsWith("x-amz-meta-")),
		)
	}

	get size() {
		return Number(this.metadata["content-length"])
	}

	get lastModifiedDate() {
		const instant = parseDate(String(this.metadata["last-modified"]))
		if (!instant)
			throw new S3Error(
				"InternalError",
				"Object metadata has an invalid modification timestamp",
			)
		return instant
	}

	declare bucket: string
	declare key: string
	declare content: TContent
	declare metadata: ObjectMetadata
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
