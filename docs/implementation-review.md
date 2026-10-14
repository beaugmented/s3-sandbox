# Implementation review

Oxlint runs through `vp lint` with correctness, suspicious-code, performance, promise, import, Node, and TypeScript rules. Type checking and type-aware linting are enabled. Explicit `any`, unsafe operations, ignored promises, and use of the legacy date global are rejected. Warnings and unused suppression comments fail `check:vp` and CI.

Temporal uses Node 26's native implementation. Storage boundaries still use the branded UTC millisecond strings and protocol timestamp helpers. The declaration bundle includes the Temporal library reference so installed consumers receive its types.

Declaration dependency exclusion uses `deps.dts.neverBundle: true`, which distinguishes external packages from local absolute paths. The former `/^[\w@]/` matcher also matched Windows drive paths and excluded local source declarations, leaving an unresolved filesystem chunk import in the published types. The installed-package contract checks the public store's method arguments as well as server, middleware, and lifecycle types on every supported platform.

## Deferred XML exception

Paths beginning with `src/` in this review are relative to `packages/s3-sandbox/`.

`src/xml-record.ts` contains the only explicit `any`. It describes the existing XML parser's dynamic output, where the same element can become a scalar, an array, or an object, and numeric text is automatically converted. The raw configuration models in `src/models/config.ts` and `src/models/routing-rule.ts` retain a scoped exception for the five unsafe-operation rules. The exception does not cover request state, headers, metadata, streams, signing, or tests.

Replacing this boundary requires schemas for CORS, website, routing, and tagging documents, plus a decision about preserving numeric coercion, repeated elements, empty elements, and the exact S3 error returned for each malformed document. Existing validation is selective; tagging currently checks XML syntax without validating the full tag schema. Keep the public XML fixtures and assertions when doing this work. Multi-object deletion and multipart completion now validate their basic input shapes before accessing them.

## Protocol anomalies requiring a decision

- **Streaming authentication:** `AwsChunkedTransform` checks chunk framing and decoded length, but it does not verify each chunk signature or the payload hash. `aws4SignatureBodyParser` documents the missing hash verification. A complete solution needs signature chaining, request signing context, and failure tests with correctly framed, tampered payloads.
- **Multipart integrity:** the completion handler reads each submitted ETag, but `FilesystemStore.putObjectMultipart` orders and concatenates parts without comparing their stored digests against those ETags. Missing-part behavior, duplicate or out-of-range part numbers, and minimum part sizes also need an explicit compatibility policy.
- **Presigned lifetimes:** signature v4 still accepts a finite negative lifetime and reports an expired request. Inherited public tests require that result. Non-finite lifetimes now produce a protocol error. Decide whether negative, fractional, and empty lifetimes should instead be rejected as invalid query parameters, then update the compatibility tests deliberately.
- **Signature v2 header timestamps:** canonicalization uses the query expiration field for v2, including header authentication where that field is absent. This merits independent tests with an external v2 signer before changing the string-to-sign calculation. Credential scope components in v4 also receive only partial validation.
- **Escaped slashes in v4 signing:** the retained canonicalization uses the raw request URI. An independently signed request using `%2F` fails when the signer canonicalizes that escape to `/`, although anonymous requests store and retrieve that key correctly. Review S3's URI encoding rules before changing signing; raw dot segments, repeated slashes, Unicode keys, and mounted paths have regression coverage.
- **Zero-ended ranges:** `FilesystemStore.getObject` uses truthiness for a range ending at byte zero, so `end: 0` becomes an unbounded range. Fix this together with tests for one-byte, empty-object, suffix, and unsatisfiable requests.

## Intentional lint exceptions

The ISO brand constructor asserts the canonical UTC millisecond string produced by Temporal. Node's `_transform` hook needs its prescribed name. Directory cleanup is sequential because each child must be removed before inspecting its parent. Repeated bucket configurations are applied in caller order so later entries replace earlier ones. Middleware factories retain per-registration handlers instead of hoisting them solely to satisfy the function-scoping rule. These exceptions are explained at their declarations or in the lint configuration.

## HTTP framework boundary

Hono owns request dispatch and error responses through its Node adapter, with global Request/Response replacement disabled. The S3 protocol context uses the raw Node URL and mount path for canonical signing and resource dispatch, avoiding Fetch URL normalization of object keys. `getHonoMiddleware(mountPath)` receives the raw request through the host adapter's bindings and strips the explicit prefix only for resource dispatch; signing includes that prefix. The public subpath, presigned URL, virtual-host URL, and object round-trip assertions now run through Hono without Express or its typings. Mounted raw-path regressions also cover dot segments, repeated slashes, and Unicode. The existing Node callback API retains support for hosts that supply `baseUrl`. The owned multipart parser streams uploads; responses bridge Node byte streams to Fetch with flow control and cancellation. Bucket configuration controls CORS and website behavior. Website error-document lookup completes before the response starts.

S3Sandbox extends EventEmitter rather than an HTTP framework. Its lifecycle, callback handlers, events, and filesystem layout remain compatible. Inherited Koa application methods and context customization are removed before the first release.

## Owned multipart parsing

`src/multipart/` absorbs the multipart-only implementation from Busboy 1.6.0 and its streaming byte matcher from StreamSearch 1.1.0. The code is erasable TypeScript under the same strict checks as the rest of the implementation. No external multipart parser or separate parser typings remain. NOTICE identifies the inherited portions and LICENSES/busboy-MIT.txt preserves Brian White's MIT notice in the repository and published package.

The existing S3 POST assertions remain. New tests cover every two-chunk split and single-byte delivery of headers, binary payloads, and closing boundaries; malformed headers and premature EOF; file backpressure; and cancellation. File parts named `file` always stream, including filename-less binary uploads, preventing text decoding and the inherited one-megabyte text-field truncation from corrupting uploaded objects. Request errors and aborts destroy the parser, which closes the active file; upload events wait for parsing to finish.

Two evaluated replacements failed independent framing probes: Multipasta 0.2.8 rejected a closing delimiter split between its final hyphens, and @fastify/busboy 3.2.3 lost file bytes when the header terminator crossed a chunk boundary. The absorbed implementation passes those probes. Revisit replacements against these regression tests rather than publication dates alone.

The inherited one-megabyte limit and truncation behavior still apply to ordinary text fields. A payload line beginning with the boundary prefix can terminate a file even when its delimiter suffix is invalid; this inherited framing behavior still needs a compatibility decision and focused correction. Atomic storage of uploads, rejection of multiple file parts, and validation of POST policy fields also remain separate decisions; the current contract stores the first file and ignores subsequent fields.

## Test client boundary

The consumer contract uses AWS SDK v3, including its matching managed-upload library. Object bodies are collected from SDK streams for byte assertions, and clients are destroyed during cleanup. Empty lists and the default bucket location normalize values omitted by the v3 deserializer; transport metadata is excluded from tagging comparisons. Copy requests explicitly supply the content type that the old SDK supplied automatically. These adaptations preserve the protocol assertions without a v2 client dependency.

Signature-v2 query tests use an independent HMAC signer for valid and expired requests. Raw-path and streaming signature-v4 tests use the AWS SDK's Smithy signer with S3 path escaping disabled. The explicitly pinned test dependencies are already in the SDK dependency tree. Smithy's signer and signing-key helper are internal SDK APIs, so their use is confined to `tests/public/signing.ts`. A small Node-crypto helper frames chained S3 chunks; a private regression checks the seed and all three chunk signatures against AWS's published upload example. Neither oracle imports the server's signing implementation. Temporal supplies explicit signing timestamps as strings. The inherited request, framing, and decoded-length assertions remain; the deferred lack of per-chunk signature verification is unchanged.

Multipart consumer tests use Node's native `FormData`, `Blob`, and `Request` encoder. File fixtures use `fs.openAsBlob()` to stream file-backed bytes. The HTTP helper passes the encoded boundary and pipes the encoder's readable body to Node HTTP with backpressure, producer-error propagation, and cancellation when the request closes. Ordered fields, duplicate files, redirects, metadata, and events retain their public assertions. Filename-less binary payloads and malformed framing remain explicit byte fixtures, independent of both the native encoder and the owned server parser. No `form-data` or DOM emulator dependency remains.

Node 26.11.1's native multipart encoder has a failure-path limitation: modifying a file after creating its file-backed Blob can produce an unhandled `NotReadableError` rejection and leave the encoded upload pending. A bounded standalone probe reproduced it, and a server integration probe timed out. Node documents that these backing files must remain unchanged; the checked-in upload fixtures obey that contract. Producer-error and disconnect regressions use controlled Node streams instead. Revisit this limitation with a Node/Undici fix before testing concurrent mutation through the native encoder. This affects test request construction, not the sandbox's owned upload parser. `DOM.AsyncIterable` supplies the native stream iterator types; Node's byte-mode `Readable.from()` bridges them without an unsafe DOM-to-Node stream assertion.

The inherited `jquery.js.gz` test fixture is an opaque upstream payload. Its embedded JavaScript still mentions the legacy date API; maintained implementation, scripts, and tests do not use that API. Dependency implementations and SDK-returned timestamp objects are also outside this migration's source scope.

The pnpm hook remains a native `.mjs` entry point and imports its erasable TypeScript implementation from `scripts/pnpm-hooks.ts`. The TypeScript 6 compiler API bridge is unchanged in purpose; maintained code is checked with TypeScript 7.
