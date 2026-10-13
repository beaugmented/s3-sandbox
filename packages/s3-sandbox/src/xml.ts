import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser"
import type { XmlRecord } from "./xml-record.ts"

/** Preserve the server's XML representation while using the maintained parser. */
type XmlOptions = {
	ignoreAttributes?: boolean
	parseNodeValue?: boolean
	attrNodeName?: string
	format?: boolean
	indentBy?: string
	tagValueProcessor?: (value: string) => string
}

export function parse(
	xml: string | Buffer,
	options: XmlOptions = {},
): XmlRecord {
	const value: unknown = new XMLParser({
		ignoreAttributes: options.ignoreAttributes ?? true,
		attributesGroupName: options.attrNodeName ?? "@",
		attributeNamePrefix: "",
		parseTagValue: options.parseNodeValue ?? true,
		processEntities: false,
		...(options.tagValueProcessor
			? {
					tagValueProcessor: (_tag, text) => options.tagValueProcessor!(text),
				}
			: {}),
	}).parse(xml.toString())
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Expected an XML document")
	return value
}

export const validate = (xml: string) => XMLValidator.validate(xml)

export class j2xParser {
	private builder: XMLBuilder
	constructor(options: XmlOptions = {}) {
		this.builder = new XMLBuilder({
			ignoreAttributes: options.ignoreAttributes ?? true,
			attributesGroupName: options.attrNodeName ?? "@",
			attributeNamePrefix: "",
			format: options.format ?? false,
			indentBy: options.indentBy ?? "  ",
			processEntities: false,
			...(options.tagValueProcessor
				? {
						tagValueProcessor: (_tag, value) =>
							options.tagValueProcessor!(String(value)),
					}
				: {}),
		})
	}
	parse(value: unknown): string {
		return this.builder.build(value)
	}
}

export function getRootTag(xml: string): string | undefined {
	const ordered: unknown = new XMLParser({
		preserveOrder: true,
		ignoreAttributes: true,
	}).parse(xml)
	if (!isUnknownArray(ordered)) return undefined
	for (const element of ordered) {
		if (element === null || typeof element !== "object") continue
		const key = Object.keys(element).find(
			(name) => !name.startsWith("?") && name !== "#text",
		)
		if (key) return key
	}
	return undefined
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value)
}

export default { parse, validate, j2xParser, getRootTag }
