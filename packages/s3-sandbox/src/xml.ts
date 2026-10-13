import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser"

/** Preserve the server's XML representation while using the maintained parser. */
type XmlOptions = {
	ignoreAttributes?: boolean
	parseNodeValue?: boolean
	attrNodeName?: string
	format?: boolean
	indentBy?: string
	tagValueProcessor?: (value: string) => string
}

export function parse(xml: string | Buffer, options: XmlOptions = {}) {
	return new XMLParser({
		ignoreAttributes: options.ignoreAttributes ?? true,
		attributesGroupName: options.attrNodeName ?? "@",
		attributeNamePrefix: "",
		parseTagValue: options.parseNodeValue ?? true,
		processEntities: false,
		...(options.tagValueProcessor
			? {
					tagValueProcessor: (_tag, value) => options.tagValueProcessor!(value),
				}
			: {}),
	}).parse(xml.toString())
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
	const ordered = new XMLParser({
		preserveOrder: true,
		ignoreAttributes: true,
	}).parse(xml)
	for (const element of ordered) {
		const key = Object.keys(element).find(
			(key) => !key.startsWith("?") && key !== "#text",
		)
		if (key) return key
	}
}

export default { parse, validate, j2xParser, getRootTag }
