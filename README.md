# S3 sandbox

A local S3-compatible server for development and tests, preparing its first release as `@beaugmented/s3-sandbox@0.1.0`.

The publishable package lives in [packages/s3-sandbox](packages/s3-sandbox). See its [README](packages/s3-sandbox/README.md) for the API, CLI, supported operations, and SDK configuration.

This fork is maintained by [beaugmented](https://github.com/beaugmented). Please report issues and request support in [this repository](https://github.com/beaugmented/s3-sandbox/issues).

## Contributing

The workspace follows [lasertag](https://github.com/jeremybanka/lasertag)'s tooling conventions: mise, pnpm, erasable TypeScript, ESM, Vite Plus, dprint, Changesets, and public-contract tests.

See [repository commands](docs/commands.md), [release setup](docs/releases.md), and [contributor guidance](AGENTS.md).

The [implementation review](docs/implementation-review.md) records the scoped XML lint exception and protocol work that needs further decisions.

## Attribution and license

This project derives from Jamie Hall's [S3rver](https://github.com/jamhall/s3rver). Its inherited S3 protocol behavior and filesystem layout are retained. This fork is licensed under [MPL-2.0](LICENSE). [NOTICE](NOTICE) identifies the inherited upstream material, whose original [MIT notice](LICENSES/MIT.txt) is preserved.
