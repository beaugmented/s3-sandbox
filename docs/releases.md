# Releases

<!-- cspell:ignore XFEQFLC BXBVWS -->

The first release is `@beaugmented/s3-sandbox@0.1.0`. The root is private; only `packages/s3-sandbox` is published. No npm publication has been performed as part of this cutover.

Before publishing, run a frozen install, `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm cov`. Inspect the tarball and its installed CLI, module exports, declarations, XML examples, license, and documentation. The ordinary public suite performs the installed-package checks.

Before 1.0, compatible features and fixes receive patch changesets; breaking changes receive minor changesets. Keep changeset bodies on one line. Changesets creates scoped release tags, which become the baseline for `break-check`. There is no scoped release baseline before the first publication. Break Check runs without task caching because new release tags can change its input.

## Publishing setup

The release workflow uses a GitHub App token to create version pull requests and release tags, and npm trusted publishing through GitHub Actions OIDC. Install a release app on this repository and configure the `CHANGESETS_APP_CLIENT_ID` variable and the `CHANGESETS_APP_PK_XFEQFLC` secret. Configure the npm package's trusted publisher for `beaugmented/s3-sandbox` with the workflow filename `release.yml`; see the [npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).

Claiming a new npm name requires an authorized initial publication. Run `pnpm release:publish` with the account allowed to create packages in the `@beaugmented` scope when the package is ready; then configure trusted publishing for subsequent automated releases. Run `pnpm release:version` only when preparing a version change; `0.1.0` is already the initial package version.

The release workflow is manually dispatched so pushing the modernization does not claim the name automatically. After the initial publication and publisher configuration, it can be enabled on pushes to `main` to follow lasertag's continuous release convention.

## Dependency maintenance

The self-hosted Renovate workflow requires a repository app with contents, pull-request, issue, and status permissions. Set the `RENOVATE_APP_CLIENT_ID` variable and the `RENOVATE_APP_PK_BXBVWS` secret. Dependency updates respect a one-day maturity window, use grouped Vite Plus and Changesets upgrades, and keep workflow action updates behind dashboard approval.

Vite Plus upgrades run the selected release's official migrator before installing the new dependencies. The workflow permits only the documented migration, installation, and formatting commands. Review migration findings and keep the toolchain versions aligned.
