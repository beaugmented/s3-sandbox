export type Credential = {
	date: string
	region: string
	service: string
	termination: string
}
export type V2Request = {
	signature: { version: 2; algorithm: "sha1"; encoding: "base64" }
	accessKeyId: string
	signatureProvided: string
	expires?: number
	time?: string
}
export type V4Request = {
	signature: { version: 4; algorithm: "sha256"; encoding: "hex" }
	accessKeyId: string
	signatureProvided: string
	credential: Credential
	time: string
	signedHeaders: string[]
}
export type AuthRequest = V2Request | V4Request
