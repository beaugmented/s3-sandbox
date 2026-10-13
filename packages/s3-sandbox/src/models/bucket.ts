class S3Bucket {
	constructor(name: string, creationDate: Date) {
		this.name = name
		this.creationDate = creationDate
	}

	declare name: string
	declare creationDate: Date
}
export default S3Bucket
