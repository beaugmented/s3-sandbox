# s3-sandbox workspace

- Treat `jeremybanka/lasertag` as the reference for repository tooling and maintenance conventions. The migration baseline is commit `1ac3cf19103e24b7ede51ce664493488540b9bef`.
- Use erasable TypeScript for source and Node scripts. Use ESM and explicit `.ts` extensions in source imports. Configuration files required by tools may use their native formats.
- Use `Temporal.Instant` for time calculations and `Iso8601` strings with UTC millisecond precision at storage boundaries. Use the protocol helpers for HTTP and AWS timestamps; do not use the legacy date global.
- Keep contributor guidance here, commands in `docs/commands.md`, release setup in `docs/releases.md`, and consumer guidance in `packages/s3-sandbox/`.
- `fmt` writes formatting; `check` aggregates `check:*` validators; `test` runs once. Coverage commands use `cov`. Keep scripts, CI, and documentation aligned.
- Treat `packages/s3-sandbox/tests/public/` as the consumer contract, including its helpers and fixtures. Keep implementation mechanics in `tests/private/`. Preserve assertions when migrating tooling.
- Keep filesystem suffixes compatible with inherited S3rver data. Use unique temporary directories for tests and close every server.
- Maintain the owned multipart parser in `packages/s3-sandbox/src/multipart/` with its framing, backpressure, and cancellation tests. Preserve and ship its MIT attribution in NOTICE and LICENSES/busboy-MIT.txt.
- Before 1.0, use patch changesets for compatible features and fixes, and minor changesets for breaking changes. Keep each changeset body on one line. The first release is `0.1.0` under `@beaugmented/s3-sandbox`.
- Use the target Vite Plus release's official `vp migrate --no-interactive` for upgrades. Preserve the previous lockfile until migration runs; review its findings and run formatting, checks, tests, and package validation.
- Runtime dependencies must be declared explicitly and pinned. Preserve the inherited MIT notices and attribution.
- Keep the explicit minimum-age exceptions for npm packages maintained by `jeremybanka` aligned in `renovate.json` and `pnpm-workspace.yaml`. Both default to one day. pnpm also exempts the Vite Plus toolchain so the official migrator can install its selected versions; those packages retain Renovate's one-day delay.
- Run Oxlint through `pnpm check:vp`; its type-aware rules reject explicit `any`, unsafe operations, and ignored promises. Keep any exception narrow and explain it in `docs/implementation-review.md`.
