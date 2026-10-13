/**
 * Deferred XML boundary: fast-xml-parser returns dynamic scalar/array/record nodes.
 * Existing handlers validate these shapes selectively. See docs/implementation-review.md.
 * This type must only describe parsed XML; it is not an application state or HTTP type.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Deferred XML schema normalization; documented in implementation-review.md.
export type XmlRecord = Record<string, any>
