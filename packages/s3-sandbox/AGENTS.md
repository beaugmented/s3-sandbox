# @beaugmented/s3-sandbox

- Import the default `S3Sandbox` class from `@beaugmented/s3-sandbox` in ESM applications. The package requires Node 26.11.1.
- Use a dedicated existing data directory, bind to a local address, and select port `0` when tests need an available port. Await `run()` and close the server in cleanup.
- Use `S3RVER` for both access and secret keys when signing requests. This is a local development server with partial S3 compatibility.
- Resolve bundled XML examples through `@beaugmented/s3-sandbox/example/cors.xml` and `website.xml`.
- Preserve HTTP status codes, XML response shapes, metadata, signatures, event payloads, and streaming behavior when editing the server.
- The CLI is `s3-sandbox`. Keep its option behavior in the public tests. Contributor and release instructions belong in the workspace root.
