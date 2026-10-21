# Repository commands

Run commands from the root with `pnpm run <command>`. `mise.toml` pins Node 26.12.1, pnpm 12.14.0, and ni 30.6.0, and adds `node_modules/.bin` to `PATH`.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm check
mise exec -- pnpm test
```

Enable the maintained pre-commit hook in a new clone with `pnpm exec vp hooks enable`. It runs the `staged` command; Vite Plus manages its generated dispatcher.

| Command            | Contract                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- |
| `fmt`              | Apply dprint formatting.                                                               |
| `check`            | Run all `check:*` static validators.                                                   |
| `check:fmt`        | Check formatting without rewriting source.                                             |
| `check:vp`         | Run Vite Plus linting and strict TypeScript checks.                                    |
| `check:spelling`   | Check maintained source and documentation spelling.                                    |
| `test`             | Run public and private tests once.                                                     |
| `test:watch`       | Watch the test suites.                                                                 |
| `test:breaks`      | Compare public tests with the latest scoped-package release tag.                       |
| `build`            | Build ESM artifacts, declarations, and source maps; validate the package with publint. |
| `cov`              | Run tests with V8 coverage and write text and LCOV reports.                            |
| `change`           | Author a changeset.                                                                    |
| `release:version`  | Prepare versions and release notes without publishing.                                 |
| `release:publish`  | Build and publish with Changesets.                                                     |
| `workflows:update` | Refresh SHA-pinned workflow action references.                                         |
| `staged`           | Format and check staged changes.                                                       |

Package-level commands retain the same meaning while narrowing scope. `test:public` and `test:private` select the corresponding suites. Public tests include installed-package checks that build and pack a disposable distribution.

`test:breaks` runs Breakage with `packages/s3-sandbox/breakage.config.json`. It restores released public tests, helpers, and fixtures and runs `test:public` against the current implementation. Run it from a clean checkout with access to `origin`. A minor changeset certifies an intentional breaking change before 1.0; see [releases](releases.md).

The inherited AWS SDK v2 fixtures exercise legacy client and signature contracts. AWS SDK v3 tests verify current client interoperability. Neither SDK is a runtime dependency.

Vite Plus runs Oxlint and strict type checking through `check:vp`; warnings and unused suppression comments fail validation. dprint handles formatting separately. The test-specific assertion rule permits Chai-style assertions through the Vite Plus test API. The declaration bundler temporarily uses TypeScript 6 through the typed hook imported by `.pnpmfile.mjs`; maintained source is checked with TypeScript 7. See the [implementation review](implementation-review.md) for the deferred XML exception and protocol anomalies.
