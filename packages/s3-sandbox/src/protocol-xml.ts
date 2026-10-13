import { z } from "zod"
import S3Error from "./models/error.ts"
import { asArray } from "./utils.ts"

const scalarString = z.union([z.string(), z.number()]).transform(String)
const objects = z.object({ Key: scalarString })
const parts = z.object({
	PartNumber: z.coerce.number(),
	ETag: scalarString,
})

export function deleteKeys(value: unknown): string[] {
	const result = z
		.object({
			Delete: z.object({ Object: z.union([objects, z.array(objects)]) }),
		})
		.safeParse(value)
	if (!result.success)
		throw new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against our published schema.",
		)
	return asArray(result.data.Delete.Object).map((object) => object.Key)
}

export function uploadParts(
	value: unknown,
): Array<{ number: number; etag: string }> {
	const result = z
		.object({
			CompleteMultipartUpload: z.object({
				Part: z.union([parts, z.array(parts)]),
			}),
		})
		.safeParse(value)
	if (!result.success)
		throw new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against our published schema.",
		)
	return asArray(result.data.CompleteMultipartUpload.Part).map((part) => ({
		number: part.PartNumber,
		etag: part.ETag.replace(/"/g, ""),
	}))
}
