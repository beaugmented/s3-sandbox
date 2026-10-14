# @beaugmented/s3-sandbox

A local S3-compatible server for development and isolated tests, derived from [S3rver](https://github.com/jamhall/s3rver). Requires Node 26.11.1 and ESM.

## Install and run

```sh
pnpm add -D @beaugmented/s3-sandbox
pnpm exec s3-sandbox --directory ./s3-data --address 127.0.0.1 --port 4568
pnpm exec s3-sandbox --help
```

The CLI creates the data directory when needed. `--configure-bucket <name> [configs...]` preconfigures a bucket with optional XML files and can be repeated. `--key` and `--cert` enable TLS. `--no-vhost-buckets` disables bucket hostnames.

## Programmatic API

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import S3Sandbox from "@beaugmented/s3-sandbox"

const directory = mkdtempSync(path.join(tmpdir(), "s3-test-"))
const sandbox = new S3Sandbox({
	directory,
	address: "127.0.0.1",
	port: 0,
	silent: true,
	configureBuckets: [{ name: "test-bucket" }],
})

try {
	const { port } = await sandbox.run()
	// Use http://127.0.0.1:${port} as the client's endpoint.
} finally {
	await sandbox.close()
	rmSync(directory, { recursive: true, force: true })
}
```

Use a dedicated existing directory for programmatic instances. Port `0` selects an available port; `run()` resolves to the listening address. Close the server in test cleanup. Stored objects survive restarts unless `resetOnClose` is enabled.

| Option                      | Default                               | Meaning                                                 |
| --------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `directory`                 | OS temporary directory + `s3-sandbox` | Filesystem storage root.                                |
| `address`                   | `localhost`                           | Host or IP to bind to.                                  |
| `port`                      | `4568`                                | HTTP port; `0` selects an available port.               |
| `silent`                    | `false`                               | Suppress request logs.                                  |
| `key`, `cert`, `pfx`        | unset                                 | Node HTTPS server options.                              |
| `serviceEndpoint`           | `amazonaws.com`                       | Service hostname suffix for virtual hosts.              |
| `vhostBuckets`              | `true`                                | Recognize bucket names in hostnames.                    |
| `resetOnClose`              | `false`                               | Delete all bucket data on server close.                 |
| `allowMismatchedSignatures` | `false`                               | Accept well-formed requests with mismatched signatures. |
| `configureBuckets`          | `[]`                                  | Bucket names and optional raw XML strings or buffers.   |

`run(callback)` and `close(callback)` retain the callback forms and return the instance. `callback()` and its alias `getMiddleware()` return a handler suitable for `http.createServer()` or an Express mount. Call `configureBuckets()` before mounting a handler directly. `reset()` clears stored bucket data.

The server uses Hono internally and extends Node's `EventEmitter`. Its public API is the S3 sandbox lifecycle and event API; HTTP framework inheritance and context customization are not supported.

## AWS SDK v3

Use `S3RVER` for both signing keys and enable path-style access:

```ts
import { S3Client } from "@aws-sdk/client-s3"

const client = new S3Client({
	endpoint: "http://127.0.0.1:4568",
	region: "us-east-1",
	forcePathStyle: true,
	credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
})
```

The checksum settings select the S3 behavior currently implemented by the sandbox. Current SDK v3 requests and legacy SDK v2 client contracts are tested.

## Supported operations

- Buckets: create, delete, list, object listings with prefixes, delimiters, markers and continuation tokens, location queries, and CORS/website configurations.
- Objects: PUT, multipart form POST, GET, HEAD, copy, single and batch deletion, tags, metadata, byte ranges, and dummy ACL responses.
- Multipart uploads: initiate, upload/copy parts, and complete.
- Authentication: signature versions 2 and 4, presigned URLs, and signed chunked uploads.
- Websites: index/error documents, redirects, routing rules, and virtual-host requests.

This is a partial S3 implementation intended for local development and tests. Unsupported operations return S3-shaped errors.

For multipart POST uploads, submit `key`, metadata, and response-control fields before the `file` part. File contents stream to storage even when the part has no filename. The server stores the first file and ignores later form fields.

## Bucket configuration and websites

Resolve bundled XML examples through their package exports:

```ts
import { readFileSync } from "node:fs"
import S3Sandbox from "@beaugmented/s3-sandbox"

const cors = new URL(
	import.meta.resolve("@beaugmented/s3-sandbox/example/cors.xml"),
)
const website = new URL(
	import.meta.resolve("@beaugmented/s3-sandbox/example/website.xml"),
)
const sandbox = new S3Sandbox({
	directory: "./s3-data",
	configureBuckets: [
		{
			name: "site.local",
			configs: [readFileSync(cors), readFileSync(website)],
		},
	],
})
```

Website requests can use a bucket path such as `http://localhost:4568/site.local/`. To use `http://site.local:4568/`, resolve `site.local` to `127.0.0.1` locally. The uploaded index document must match the bucket's website configuration.

See the AWS examples for [CORS](https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTcors.html) and [website configuration](https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTwebsite.html).

## Events

Subscribe before performing object operations:

```ts
sandbox.on("event", (event) => {
	console.log(event.Records[0].eventName)
})
```

PUT, POST, COPY, and DELETE operations emit notifications following the [S3 event structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html).

## License and attribution

This fork is licensed under [MPL-2.0](LICENSE). It derives from Jamie Hall's S3rver; [NOTICE](NOTICE) identifies the inherited material and its original [MIT notice](LICENSES/MIT.txt). The upstream filesystem suffixes are preserved.

The absorbed multipart implementation also retains Brian White's [MIT notice](LICENSES/busboy-MIT.txt).
