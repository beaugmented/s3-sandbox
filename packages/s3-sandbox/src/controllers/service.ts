import { DUMMY_ACCOUNT } from "../models/account.ts"
import { type S3Context } from "../types.ts"

/*
 * Operations on the Service
 * The following methods correspond to operations you can perform on the Amazon S3 service.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/RESTServiceOps.html
 */

/**
 * GET Service
 * This implementation of the GET operation returns a list of all buckets owned by the authenticated
 * sender of the request.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTServiceGET.html}
 */
export async function getService(ctx: S3Context) {
	const buckets = await ctx.store.listBuckets()
	ctx.logger.info("Fetched %d buckets", buckets.length)
	ctx.body = {
		ListAllMyBucketsResult: {
			"@": { xmlns: "http://doc.s3.amazonaws.com/2006-03-01/" },
			Owner: {
				ID: DUMMY_ACCOUNT.id,
				DisplayName: DUMMY_ACCOUNT.displayName,
			},
			Buckets: {
				Bucket: buckets.map((bucket) => ({
					Name: bucket.name,
					CreationDate: bucket.creationDate,
				})),
			},
		},
	}
}
