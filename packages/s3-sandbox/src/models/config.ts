import escapeRegExp from "lodash/escapeRegExp.js"
import * as he from "he"
import { asArray } from "../utils.ts"
import xmlParser from "../xml.ts"

import S3Error from "./error.ts"
import RoutingRule from "./routing-rule.ts"

export const getConfigModel = function getConfigModel(type: any) {
	switch (type) {
		case "cors":
			return S3CorsConfiguration
		case "website":
			return S3WebsiteConfiguration
		case "tagging":
			return TaggingConfiguration
	}
}

class S3ConfigBase {
	/**
	 * Validates a given XML config against S3's spec.
	 * @param {string} xml
	 * @returns S3Config
	 */
	static validate(_xml: string) {
		throw new Error("Not implemented")
	}

	/**
	 * Parses an XML document
	 * @param {string} type
	 * @param {string} config
	 */
	constructor(type: string, config: string) {
		if (this.constructor === S3ConfigBase) {
			throw new Error("Cannot create an instance of an abstract class")
		}
		this.type = type
		this.rawConfig = xmlParser.parse(config, {
			ignoreAttributes: false,
			parseNodeValue: true,
			tagValueProcessor: he.decode,
		})
	}

	toJSON() {
		return this.rawConfig
	}

	toXML(space?: number) {
		const parser = new xmlParser.j2xParser({
			ignoreAttributes: false,
			format: typeof space === "number",
			indentBy: " ".repeat(space ?? 0),
		})
		return parser.parse(this.rawConfig)
	}

	declare type: string
	declare rawConfig: Record<string, any>
}

class S3CorsConfiguration extends S3ConfigBase {
	static validate(xml: string) {
		if (xmlParser.validate(xml) !== true) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}
		const config = new S3CorsConfiguration(xml)
		const { CORSConfiguration } = config.rawConfig
		if (!CORSConfiguration || !CORSConfiguration.CORSRule) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}
		for (const rule of asArray(CORSConfiguration.CORSRule)) {
			if (
				!rule.AllowedOrigin ||
				!rule.AllowedMethod ||
				Array.isArray(rule.MaxAgeSeconds)
			) {
				throw new S3Error(
					"MalformedXML",
					"The XML you provided was not well-formed or did not validate " +
						"against our published schema",
				)
			}

			for (const method of asArray(rule.AllowedMethod)) {
				if (!S3CorsConfiguration.allowedMethods.includes(method)) {
					throw new S3Error(
						"InvalidRequest",
						"Found unsupported HTTP method in CORS config. Unsupported method is " +
							method,
					)
				}
			}
		}
		return config
	}

	static createWildcardRegExp(str: string, flags = "") {
		const parts = str.split("*")
		if (parts.length > 2)
			throw new S3Error(
				"InvalidRequest",
				`AllowedOrigin "${str}" can not have more than one wildcard.`,
			)
		return new RegExp(`^${parts.map(escapeRegExp).join(".*")}$`, flags)
	}

	constructor(config: string) {
		super("cors", config)
		const { CORSConfiguration = {} } = this.rawConfig
		this.rules = asArray(CORSConfiguration.CORSRule || []).map((rule: any) => ({
			hasWildcardOrigin: asArray(rule.AllowedOrigin || []).includes("*"),
			allowedOrigins: asArray(rule.AllowedOrigin || []).map((o: any) =>
				S3CorsConfiguration.createWildcardRegExp(o),
			),
			allowedMethods: asArray(rule.AllowedMethod || []),
			allowedHeaders: asArray(rule.AllowedHeader || []).map((h: any) =>
				S3CorsConfiguration.createWildcardRegExp(h, "i"),
			),
			exposeHeaders: asArray(rule.ExposeHeader || []),
			maxAgeSeconds: rule.MaxAgeSeconds,
		}))
	}

	matchRule(origin: string, method: string) {
		return this.rules.find(
			(rule: any) =>
				rule.allowedOrigins.some((pattern: RegExp) => pattern.test(origin)) &&
				rule.allowedMethods.includes(method.toUpperCase()),
		)
	}

	getAllowedHeaders(
		rule: {
			hasWildcardOrigin: boolean
			allowedOrigins: RegExp[]
			allowedMethods: string[]
			allowedHeaders: RegExp[]
			exposeHeaders: string[]
			maxAgeSeconds?: number
		},
		requestHeaders: string[] | undefined,
	) {
		if (!requestHeaders) return []
		return requestHeaders
			.map((header: string) => header.trim().toLowerCase())
			.filter((header: string) =>
				rule.allowedHeaders.some((pattern: RegExp) => pattern.test(header)),
			)
	}

	declare rules: Array<{
		hasWildcardOrigin: boolean
		allowedOrigins: RegExp[]
		allowedMethods: string[]
		allowedHeaders: RegExp[]
		exposeHeaders: string[]
		maxAgeSeconds?: number
	}>
	static allowedMethods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
}
// https://docs.aws.amazon.com/AmazonS3/latest/dev/cors.html#cors-allowed-methods
export { S3CorsConfiguration }

class S3WebsiteConfiguration extends S3ConfigBase {
	static validate(xml: string) {
		if (xmlParser.validate(xml) !== true) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}

		const config = new S3WebsiteConfiguration(xml)
		const { WebsiteConfiguration } = config.rawConfig
		if (!WebsiteConfiguration) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}
		const {
			IndexDocument,
			ErrorDocument,
			RedirectAllRequestsTo,
			RoutingRules,
		} = WebsiteConfiguration
		if (RedirectAllRequestsTo) {
			if (Array.isArray(RedirectAllRequestsTo)) {
				throw new S3Error(
					"MalformedXML",
					"The XML you provided was not well-formed or did not validate " +
						"against our published schema",
				)
			}
			if (IndexDocument) {
				throw new S3Error(
					"InvalidArgument",
					"RedirectAllRequestsTo cannot be provided in conjunction with " +
						"other Routing Rules.",
					{
						ArgumentName: "RedirectAllRequestsTo",
						ArgumentValue: "not null",
					},
				)
			}
		} else if (IndexDocument) {
			if (
				Array.isArray(IndexDocument) ||
				!IndexDocument.Suffix ||
				Array.isArray(IndexDocument.Suffix)
			) {
				throw new S3Error(
					"MalformedXML",
					"The XML you provided was not well-formed or did not validate " +
						"against our published schema",
				)
			}
			if (ErrorDocument) {
				if (
					Array.isArray(ErrorDocument) ||
					!ErrorDocument.Key ||
					Array.isArray(ErrorDocument.Key)
				) {
					throw new S3Error(
						"MalformedXML",
						"The XML you provided was not well-formed or did not validate " +
							"against our published schema",
					)
				}
			}
		} else {
			throw new S3Error(
				"InvalidArgument",
				"A value for IndexDocument Suffix must be provided if RedirectAllRequestsTo is empty",
				{
					ArgumentName: "IndexDocument",
					ArgumentValue: "null",
				},
			)
		}
		if (
			!IndexDocument ||
			Array.isArray(ErrorDocument) ||
			(ErrorDocument && !ErrorDocument.Key)
		) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}
		if (IndexDocument.Suffix.indexOf("/") !== -1) {
			throw new S3Error(
				"InvalidArgument",
				"The IndexDocument Suffix is not well formed",
				{
					ArgumentName: "IndexDocument",
					ArgumentValue: IndexDocument.Suffix,
				},
			)
		}
		if (RoutingRules) {
			if (Array.isArray(RoutingRules) || !RoutingRules.RoutingRule) {
				throw new S3Error(
					"MalformedXML",
					"The XML you provided was not well-formed or did not validate " +
						"against our published schema",
				)
			}

			const routingRules = Array.isArray(RoutingRules.RoutingRule)
				? RoutingRules.RoutingRule
				: [RoutingRules.RoutingRule]

			for (const { Condition, Redirect } of routingRules) {
				if (
					(Condition &&
						!Condition.KeyPrefixEquals &&
						!Condition.HttpErrorCodeReturnedEquals) ||
					!Redirect ||
					(!Redirect.HostName &&
						!Redirect.Protocol &&
						!Redirect.ReplaceKeyPrefixWith &&
						!Redirect.ReplaceKeyWith &&
						!Redirect.HttpRedirectCode)
				) {
					throw new S3Error(
						"MalformedXML",
						"The XML you provided was not well-formed or did not validate " +
							"against our published schema",
					)
				}

				if (
					Condition &&
					Condition.HttpErrorCodeReturnedEquals &&
					(Condition.HttpErrorCodeReturnedEquals < 400 ||
						Condition.HttpErrorCodeReturnedEquals >= 600)
				) {
					throw new S3Error(
						"InvalidArgument",
						`The provided HTTP error code (${Condition.HttpErrorCodeReturnedEquals}) is not valid. Valid codes are 4XX or 5XX.`,
						{
							ArgumentName: "HttpErrorCodeReturnedEquals",
							ArgumentValue: Condition.HttpErrorCodeReturnedEquals,
						},
					)
				}

				if (
					Redirect.Protocol &&
					Redirect.Protocol !== "http" &&
					Redirect.Protocol !== "https"
				) {
					throw new S3Error(
						"InvalidArgument",
						"Invalid protocol, protocol can be http or https. If not defined the protocol will be selected automatically.",
						{
							ArgumentName: "Protocol",
							ArgumentValue: Redirect.Protocol,
						},
					)
				}

				if (Redirect.ReplaceKeyWith && Redirect.ReplaceKeyPrefixWith) {
					throw new S3Error(
						"MalformedXML",
						"You can only define ReplaceKeyPrefix or ReplaceKey but not both.",
					)
				}
			}
		}
		return config
	}

	constructor(config: string) {
		super("website", config)
		const { WebsiteConfiguration = {} } = this.rawConfig
		if (WebsiteConfiguration.IndexDocument) {
			this.indexDocumentSuffix = WebsiteConfiguration.IndexDocument.Suffix
			if (WebsiteConfiguration.ErrorDocument) {
				this.errorDocumentKey = WebsiteConfiguration.ErrorDocument.Key
			}
		}
		if (
			WebsiteConfiguration.RoutingRules &&
			WebsiteConfiguration.RoutingRules.RoutingRule
		) {
			const routingRules = Array.isArray(
				WebsiteConfiguration.RoutingRules.RoutingRule,
			)
				? WebsiteConfiguration.RoutingRules.RoutingRule
				: [WebsiteConfiguration.RoutingRules.RoutingRule]
			this.routingRules = routingRules.map(
				(config: any) => new RoutingRule(config),
			)
		}
	}

	declare indexDocumentSuffix: string | undefined
	declare errorDocumentKey: string | undefined
	declare routingRules: RoutingRule[]
}
export { S3WebsiteConfiguration }

class TaggingConfiguration extends S3ConfigBase {
	static validate(xml: string) {
		if (xmlParser.validate(xml) !== true) {
			throw new S3Error(
				"MalformedXML",
				"The XML you provided was not well-formed or did not validate " +
					"against our published schema",
			)
		}

		return new TaggingConfiguration(xml)
	}

	constructor(config: string) {
		super("tagging", config)
	}

	static EMPTY = new TaggingConfiguration(`<Tagging><TagSet /></Tagging>`)
}

export { TaggingConfiguration }
