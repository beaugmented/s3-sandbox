import {
	parseMetadata,
	selectMetadata,
	type ObjectMetadata,
} from "../metadata.ts"
import { type TransformCallback, type Readable } from "node:stream"
import { hasErrorCode } from "../error-tools.ts"
import { iso8601FromInstant, toHttpDate } from "../temporal-tools.ts"
import crypto from "node:crypto"
import {
	createReadStream,
	createWriteStream,
	promises as fs,
	readdirSync,
	rmSync,
} from "node:fs"
import path from "node:path"
import { pipeline, Transform } from "node:stream"
import { format } from "node:util"

import S3Bucket from "../models/bucket.ts"
import {
	getConfigModel,
	S3CorsConfiguration,
	S3WebsiteConfiguration,
	TaggingConfiguration,
} from "../models/config.ts"
import S3Object from "../models/object.ts"
import { concatStreams, ensureDir, walk } from "../utils.ts"

const S3RVER_SUFFIX = "%s._S3rver_%s"

class FilesystemStore {
	static decodeKeyPath(
		keyPath: string,
		platform: NodeJS.Platform = process.platform,
	) {
		return platform === "win32"
			? keyPath.replace(/&../g, (ent) =>
					Buffer.from(ent.slice(1), "hex").toString(),
				)
			: keyPath
	}

	static encodeKeyPath(
		key: string,
		platform: NodeJS.Platform = process.platform,
	) {
		return platform === "win32"
			? key.replace(
					/[<>:"\\|?*]/g,
					(ch) => "&" + Buffer.from(ch, "utf8").toString("hex"),
				)
			: key
	}

	constructor(rootDirectory: string) {
		this.rootDirectory = rootDirectory
	}

	// helpers
	getBucketPath(bucketName: string) {
		return path.join(this.rootDirectory, bucketName)
	}

	getResourcePath(bucket: string, key = "", resource: string) {
		const parts = FilesystemStore.encodeKeyPath(key).split("/")
		const suffix = format(S3RVER_SUFFIX, parts.pop(), resource)
		return path.join(this.rootDirectory, bucket, ...parts, suffix)
	}

	async getMetadata(bucket: string, key: string) {
		const objectPath = this.getResourcePath(bucket, key, "object")
		const metadataPath = this.getResourcePath(bucket, key, "metadata.json")

		// this is expected to throw if the object doesn't exist
		const stat = await fs.stat(objectPath)
		const [storedMetadata, md5] = await Promise.all([
			fs
				.readFile(metadataPath)
				.then((data) => parseMetadata(data.toString("utf8")))
				.catch((err: unknown) => {
					if (hasErrorCode(err, "ENOENT")) return undefined
					throw err
				}),
			fs
				.readFile(`${objectPath}.md5`)
				.then((digest) => digest.toString())
				.catch(async (err: unknown) => {
					if (!hasErrorCode(err, "ENOENT")) throw err
					// create the md5 file if it doesn't already exist
					const digest = await new Promise<string>((resolve, reject) => {
						const stream = createReadStream(objectPath)
						const md5Context = crypto.createHash("md5")
						stream.on("error", reject)
						stream.on("data", (chunk) => md5Context.update(chunk, "utf8"))
						stream.on("end", () => resolve(md5Context.digest("hex")))
					})
					await fs.writeFile(`${objectPath}.md5`, digest)
					return digest
				}),
		])

		return {
			...storedMetadata,
			etag: JSON.stringify(md5),
			"last-modified": toHttpDate(
				Temporal.Instant.fromEpochMilliseconds(Math.trunc(stat.mtimeMs)),
			),
			"content-length": stat.size,
		}
	}

	async putMetadata(
		bucket: string,
		key: string,
		metadata: ObjectMetadata,
		md5?: string,
	) {
		const metadataPath = this.getResourcePath(bucket, key, "metadata.json")
		const md5Path = this.getResourcePath(bucket, key, "object.md5")

		const json = selectMetadata(metadata, S3Object.ALLOWED_METADATA)

		if (md5) await fs.writeFile(md5Path, md5)
		await fs.writeFile(metadataPath, JSON.stringify(json, null, 2))
	}

	async putContent(
		objectPath: string,
		content: Readable | Buffer,
	): Promise<[number, string]> {
		return new Promise((resolve, reject) => {
			const writeStream = createWriteStream(objectPath)
			const md5Context = crypto.createHash("md5")

			if (Buffer.isBuffer(content)) {
				md5Context.update(content)
				const digest = md5Context.digest("hex")
				writeStream.once("error", reject)
				writeStream.end(content, (error?: Error | null) =>
					error ? reject(error) : resolve([content.length, digest]),
				)
			} else {
				let totalLength = 0
				pipeline(
					content,
					new Transform({
						transform(
							chunk: Buffer,
							encoding: BufferEncoding,
							callback: TransformCallback,
						) {
							md5Context.update(chunk, encoding)
							totalLength += chunk.length
							callback(null, chunk)
						},
					}),
					writeStream,
					(err) =>
						err
							? reject(err)
							: resolve([totalLength, md5Context.digest("hex")]),
				)
			}
		})
	}
	// store implementation

	reset() {
		const list = readdirSync(this.rootDirectory)
		for (const file of list) {
			rmSync(path.join(this.rootDirectory, file), {
				recursive: true,
				force: true,
			})
		}
	}

	async listBuckets() {
		const list = await fs.readdir(this.rootDirectory)
		const buckets = await Promise.all(
			list.map((filename) => this.getBucket(filename)),
		)
		return buckets.filter((bucket) => bucket !== null)
	}

	async getBucket(bucket: string) {
		const bucketPath = this.getBucketPath(bucket)
		try {
			const stat = await fs.stat(bucketPath)
			if (!stat.isDirectory()) return null
			return new S3Bucket(
				bucket,
				iso8601FromInstant(
					Temporal.Instant.fromEpochMilliseconds(Math.trunc(stat.birthtimeMs)),
				),
			)
		} catch (err: unknown) {
			if (hasErrorCode(err, "ENOENT")) return null
			throw err
		}
	}

	async putBucket(bucket: string) {
		const bucketPath = this.getBucketPath(bucket)
		await ensureDir(bucketPath)
		return this.getBucket(bucket)
	}

	async deleteBucket(bucket: string) {
		return fs.rm(this.getBucketPath(bucket), { recursive: true, force: true })
	}

	async listObjects(
		bucket: string,
		options: {
			delimiter?: string | undefined
			startAfter?: string | undefined
			prefix?: string | undefined
			maxKeys?: number
		},
	) {
		const {
			delimiter = "",
			startAfter = "",
			prefix = "",
			maxKeys = Infinity,
		} = options
		const bucketPath = this.getBucketPath(bucket)

		const delimiterEnc = FilesystemStore.encodeKeyPath(delimiter)
		const startAfterPath = [
			bucketPath,
			FilesystemStore.encodeKeyPath(startAfter),
		].join("/")
		const prefixPath = [bucketPath, FilesystemStore.encodeKeyPath(prefix)].join(
			"/",
		)

		const it = walk(bucketPath, (dirPath) => {
			// avoid directories occurring before the startAfter parameter
			if (dirPath < startAfterPath && startAfterPath.indexOf(dirPath) === -1) {
				return false
			}
			if (dirPath.startsWith(prefixPath)) {
				if (
					delimiterEnc &&
					dirPath.slice(prefixPath.length).indexOf(delimiterEnc) !== -1
				) {
					// avoid directories occurring beneath a common prefix
					return false
				}
			} else if (!prefixPath.startsWith(dirPath)) {
				// avoid directories that do not intersect with any part of the prefix
				return false
			}
			return true
		})

		const commonPrefixes = new Set<string>()
		const objectSuffix = format(S3RVER_SUFFIX, "", "object")
		const keys: string[] = []
		let isTruncated = false
		for (const keyPath of it) {
			if (!keyPath.endsWith(objectSuffix)) {
				continue
			}

			const key = FilesystemStore.decodeKeyPath(
				keyPath.slice(bucketPath.length + 1, -objectSuffix.length),
			)

			if (key <= startAfter || !key.startsWith(prefix)) {
				continue
			}

			if (delimiter) {
				const idx = key.slice(prefix.length).indexOf(delimiter)
				if (idx !== -1) {
					// add to common prefixes before filtering this key out
					commonPrefixes.add(key.slice(0, prefix.length + idx + 1))
					continue
				}
			}

			if (keys.length < maxKeys) {
				keys.push(key)
			} else {
				isTruncated = true
				break
			}
		}

		const metadataArr = await Promise.all(
			keys.map((key) =>
				this.getMetadata(bucket, key).catch((err: unknown) => {
					if (hasErrorCode(err, "ENOENT")) return undefined
					throw err
				}),
			),
		)

		return {
			objects: keys.flatMap((key, index) => {
				const metadata = metadataArr[index]
				return metadata ? [new S3Object(bucket, key, null, metadata)] : []
			}),
			commonPrefixes: [...commonPrefixes].toSorted((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
			isTruncated,
		}
	}

	async existsObject(bucket: string, key: string) {
		const objectPath = this.getResourcePath(bucket, key, "object")
		try {
			await fs.stat(objectPath)
			return true
		} catch (err: unknown) {
			if (hasErrorCode(err, "ENOENT")) return false
			throw err
		}
	}

	async getObject(
		bucket: string,
		key: string,
		options?: { start?: number; end?: number },
	) {
		try {
			const metadata = await this.getMetadata(bucket, key)
			const lastByte = Math.max(0, metadata["content-length"] - 1)
			const range = {
				// TODO: preserve an explicit end of zero; see docs/implementation-review.md.
				start: (options && options.start) || 0,
				end: Math.min((options && options.end) || Infinity, lastByte),
			}

			if (range.start < 0 || Math.min(range.end, lastByte) < range.start) {
				// the range is not satisfiable
				const object = new S3Object(bucket, key, null, metadata)
				if (options && (options.start !== undefined || options.end)) {
					object.range = range
				}
				return object
			}

			const content = await new Promise<Readable>((resolve, reject) => {
				const stream = createReadStream(
					this.getResourcePath(bucket, key, "object"),
					range,
				)
					.on("error", reject)
					.on("open", () => resolve(stream))
			})
			const object = new S3Object(bucket, key, content, metadata)
			if (options && (options.start !== undefined || options.end)) {
				object.range = range
			}
			return object
		} catch (err: unknown) {
			if (hasErrorCode(err, "ENOENT")) return null
			throw err
		}
	}

	async putObject(object: S3Object) {
		if (object.content === null)
			throw new TypeError("Cannot store an object without content")
		const objectPath = this.getResourcePath(object.bucket, object.key, "object")

		await ensureDir(path.dirname(objectPath))
		const [size, md5] = await this.putContent(objectPath, object.content)
		await this.putMetadata(object.bucket, object.key, object.metadata, md5)
		return { size, md5 }
	}

	async copyObject(
		srcBucket: string,
		srcKey: string,
		destBucket: string,
		destKey: string,
		replacementMetadata: ObjectMetadata | null,
	) {
		const srcObjectPath = this.getResourcePath(srcBucket, srcKey, "object")
		const destObjectPath = this.getResourcePath(destBucket, destKey, "object")

		if (srcObjectPath !== destObjectPath) {
			await ensureDir(path.dirname(destObjectPath))
			await fs.copyFile(srcObjectPath, destObjectPath)
		}

		if (replacementMetadata) {
			await this.putMetadata(destBucket, destKey, replacementMetadata)
			return this.getMetadata(destBucket, destKey)
		} else {
			if (srcObjectPath !== destObjectPath) {
				await Promise.all([
					fs.copyFile(
						this.getResourcePath(srcBucket, srcKey, "metadata.json"),
						this.getResourcePath(destBucket, destKey, "metadata.json"),
					),
					fs.copyFile(
						this.getResourcePath(srcBucket, srcKey, "object.md5"),
						this.getResourcePath(destBucket, destKey, "object.md5"),
					),
				])
			}
			return this.getMetadata(destBucket, destKey)
		}
	}

	async deleteObject(bucket: string, key: string) {
		await Promise.all(
			[
				this.getResourcePath(bucket, key, "object"),
				this.getResourcePath(bucket, key, "object.md5"),
				this.getResourcePath(bucket, key, "metadata.json"),
			].map((filePath) =>
				fs.unlink(filePath).catch((err: unknown) => {
					if (!hasErrorCode(err, "ENOENT")) throw err
				}),
			),
		)
		// clean up empty directories
		const bucketPath = this.getBucketPath(bucket)
		const parts = key.split("/")
		// the last part isn't a directory (it's embedded into the file name)
		parts.pop()
		while (
			parts.length &&
			!readdirSync(path.join(bucketPath, ...parts)).length
		) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Remove each empty child before checking its parent.
			await fs.rmdir(path.join(bucketPath, ...parts))
			parts.pop()
		}
	}

	async initiateUpload(
		bucket: string,
		key: string,
		uploadId: string,
		metadata: ObjectMetadata,
	) {
		const uploadDir = path.join(
			this.getResourcePath(bucket, undefined, "uploads"),
			uploadId,
		)

		await ensureDir(uploadDir)

		await Promise.all([
			fs.writeFile(path.join(uploadDir, "key"), key),
			fs.writeFile(path.join(uploadDir, "metadata"), JSON.stringify(metadata)),
		])
	}

	async putPart(
		bucket: string,
		uploadId: string,
		partNumber: number,
		content: Readable | Buffer,
	) {
		const partPath = path.join(
			this.getResourcePath(bucket, undefined, "uploads"),
			uploadId,
			partNumber.toString(),
		)

		await ensureDir(path.dirname(partPath))

		const [size, md5] = await this.putContent(partPath, content)
		await fs.writeFile(`${partPath}.md5`, md5)
		return { size, md5 }
	}

	async putObjectMultipart(
		bucket: string,
		uploadId: string,
		parts: Array<{ number: number; etag: string }>,
	) {
		// TODO: check submitted ETags and part constraints; see docs/implementation-review.md.
		const uploadDir = path.join(
			this.getResourcePath(bucket, undefined, "uploads"),
			uploadId,
		)
		const [key, metadata] = await Promise.all([
			fs.readFile(path.join(uploadDir, "key")).then((data) => data.toString()),
			fs
				.readFile(path.join(uploadDir, "metadata"))
				.then((data) => parseMetadata(data.toString("utf8"))),
		])
		const partStreams = parts
			.toSorted((a, b) => a.number - b.number)
			.map((part) =>
				createReadStream(path.join(uploadDir, part.number.toString())),
			)
		const object = new S3Object(
			bucket,
			key,
			concatStreams(partStreams),
			metadata,
		)
		const result = await this.putObject(object)
		await fs.rm(uploadDir, { recursive: true, force: true })
		return result
	}

	getSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: "cors",
	): Promise<S3CorsConfiguration | null>
	getSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: "website",
	): Promise<S3WebsiteConfiguration | null>
	getSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: "tagging",
	): Promise<TaggingConfiguration | null>
	getSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: string,
	): Promise<
		S3CorsConfiguration | S3WebsiteConfiguration | TaggingConfiguration | null
	>
	async getSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: string,
	) {
		const resourcePath = this.getResourcePath(
			bucket,
			key,
			`${resourceType}.xml`,
		)

		const Model = getConfigModel(resourceType)
		if (!Model) throw new Error(`Unsupported subresource: ${resourceType}`)

		try {
			const data = await fs.readFile(resourcePath)
			return new Model(data.toString())
		} catch (err: unknown) {
			if (hasErrorCode(err, "ENOENT")) return null
			throw err
		}
	}

	async putSubresource(
		bucket: string,
		key: string | undefined,
		resource:
			| S3CorsConfiguration
			| S3WebsiteConfiguration
			| TaggingConfiguration,
	) {
		const resourcePath = this.getResourcePath(
			bucket,
			key,
			`${resource.type}.xml`,
		)
		await fs.writeFile(resourcePath, resource.toXML(2))
	}

	async deleteSubresource(
		bucket: string,
		key: string | undefined,
		resourceType: string,
	) {
		const resourcePath = this.getResourcePath(
			bucket,
			key,
			`${resourceType}.xml`,
		)
		try {
			await fs.unlink(resourcePath)
		} catch (err: unknown) {
			if (!hasErrorCode(err, "ENOENT")) throw err
		}
	}

	declare rootDirectory: string
}

export default FilesystemStore
