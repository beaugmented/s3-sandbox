import type { Iso8601 } from "../temporal-tools.ts"

class S3Bucket {
	constructor(name: string, creationDate: Iso8601) {
		this.name = name
		this.creationDate = creationDate
	}

	declare name: string
	declare creationDate: Iso8601
}
export default S3Bucket
