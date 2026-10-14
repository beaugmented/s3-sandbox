import { describe, expect, it } from "vite-plus/test"
import {
	S3CorsConfiguration,
	S3WebsiteConfiguration,
	TaggingConfiguration,
} from "../../../src/models/config.ts"

const index = "<IndexDocument><Suffix>index.html</Suffix></IndexDocument>"
const redirect =
	"<RedirectAllRequestsTo><HostName>example.com</HostName></RedirectAllRequestsTo>"

describe("Configuration validation boundaries", () => {
	it.each([
		{ xml: "<WebsiteConfiguration>", code: "MalformedXML" },
		{ xml: "<Other/>", code: "MalformedXML" },
		{
			xml: `<WebsiteConfiguration>${redirect}${redirect}</WebsiteConfiguration>`,
			code: "MalformedXML",
		},
		{
			xml: `<WebsiteConfiguration>${redirect}${index}</WebsiteConfiguration>`,
			code: "InvalidArgument",
		},
		{
			xml: `<WebsiteConfiguration>${index}${index}</WebsiteConfiguration>`,
			code: "MalformedXML",
		},
		{
			xml: "<WebsiteConfiguration><IndexDocument/></WebsiteConfiguration>",
			code: "InvalidArgument",
		},
		{
			xml: "<WebsiteConfiguration><IndexDocument><Suffix>a</Suffix><Suffix>b</Suffix></IndexDocument></WebsiteConfiguration>",
			code: "MalformedXML",
		},
		{
			xml: `<WebsiteConfiguration>${index}<ErrorDocument><Other>missing key</Other></ErrorDocument></WebsiteConfiguration>`,
			code: "MalformedXML",
		},
		{
			xml: `<WebsiteConfiguration>${index}<ErrorDocument><Key>a</Key><Key>b</Key></ErrorDocument></WebsiteConfiguration>`,
			code: "MalformedXML",
		},
		{
			xml: `<WebsiteConfiguration>${index}<ErrorDocument><Key>a</Key></ErrorDocument><ErrorDocument><Key>b</Key></ErrorDocument></WebsiteConfiguration>`,
			code: "MalformedXML",
		},
		{ xml: "<WebsiteConfiguration/>", code: "MalformedXML" },
		{
			xml: "<WebsiteConfiguration><IndexDocument><Suffix>nested/index.html</Suffix></IndexDocument></WebsiteConfiguration>",
			code: "InvalidArgument",
		},
	])("rejects website XML with $code: $xml", ({ xml, code }) => {
		expect(() => S3WebsiteConfiguration.validate(xml)).toThrow(
			expect.objectContaining({ code }),
		)
	})
	it.each([
		"<CORSConfiguration>",
		"<Other/>",
		"<CORSConfiguration/>",
		"<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin></CORSRule></CORSConfiguration>",
		"<CORSConfiguration><CORSRule><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>",
		"<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><MaxAgeSeconds>1</MaxAgeSeconds><MaxAgeSeconds>2</MaxAgeSeconds></CORSRule></CORSConfiguration>",
	])("rejects malformed CORS XML: %s", (xml) => {
		expect(() => S3CorsConfiguration.validate(xml)).toThrow(
			expect.objectContaining({ code: "MalformedXML" }),
		)
	})
	it("rejects malformed tagging XML", () => {
		expect(() => TaggingConfiguration.validate("<Tagging>")).toThrow(
			expect.objectContaining({ code: "MalformedXML" }),
		)
	})
	it("serializes validated configurations to JSON and back to XML", () => {
		const config = S3WebsiteConfiguration.validate(
			`<WebsiteConfiguration>${index}</WebsiteConfiguration>`,
		)
		expect(JSON.parse(JSON.stringify(config))).toEqual({
			WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" } },
		})
		expect(
			S3WebsiteConfiguration.validate(config.toXML(2)).indexDocumentSuffix,
		).toBe("index.html")
	})
})
