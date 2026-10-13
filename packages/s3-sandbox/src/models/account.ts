class AWSAccount {
	constructor(accountId: number, displayName: string) {
		this.id = accountId
		this.displayName = displayName
		this.accessKeys = new Map()
	}

	createKeyPair(accessKeyId: string, secretAccessKey: string) {
		AWSAccount.registry.set(accessKeyId, this)
		this.accessKeys.set(accessKeyId, secretAccessKey)
	}

	revokeAccessKey(accessKeyId: string) {
		AWSAccount.registry.delete(accessKeyId)
		this.accessKeys.delete(accessKeyId)
	}

	declare id: number
	declare displayName: string
	declare accessKeys: Map<string, string>
	static registry = new Map<string, AWSAccount>()
}

export default AWSAccount

// Hardcoded dummy user used for authenticated requests
export const DUMMY_ACCOUNT = new AWSAccount(123456789000, "S3rver")
DUMMY_ACCOUNT.createKeyPair("S3RVER", "S3RVER")
