# Releases

<!-- cspell:ignore XFEQFLC BXBVWS -->

The first release is `@beaugmented/s3-sandbox@0.1.0`. The root is private; only `packages/s3-sandbox` is published.

Before publishing, run a frozen install, `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm cov`. Inspect the tarball and its installed CLI, module exports, declarations, XML examples, license, and documentation. The ordinary public suite performs the installed-package checks.

Before 1.0, compatible features and fixes receive patch changesets; breaking changes receive minor changesets. Keep changeset bodies on one line. Changesets creates scoped release tags, which become the baseline for `break-check`. There is no scoped release baseline before the first publication. Break Check runs without task caching because new release tags can change its input.

## Publishing setup

The release workflow uses a GitHub App token to create version pull requests and release tags, and npm trusted publishing through GitHub Actions OIDC. Install a release app on this repository and configure the `CHANGESETS_APP_CLIENT_ID` variable and the `CHANGESETS_APP_PK_XFEQFLC` secret. Configure the npm package's trusted publisher for `beaugmented/s3-sandbox` with the workflow filename `release.yml`; see the [npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).

Claiming a new npm name requires an authorized initial publication. Run `pnpm release:publish` with the account allowed to create packages in the `@beaugmented` scope when the package is ready; then configure trusted publishing for subsequent automated releases. Run `pnpm release:version` only when preparing a version change; `0.1.0` is already the initial package version.

The release workflow runs on every push to `main`, following lasertag's continuous release convention. Pending changesets create or update a version pull request. After that pull request is merged, the workflow builds and publishes unpublished package versions and creates scoped release tags. Configure the npm trusted publisher after the initial publication and before enabling subsequent automated releases.

The Check and Test workflows validate pull requests independently. Release uses the shared frozen-install setup and calls `pnpm release:version` or `pnpm release:publish` through Changesets, without repeating those validation jobs.

## Dependency maintenance

The self-hosted Renovate workflow requires a repository app with contents, pull-request, issue, and status permissions. Set the `RENOVATE_APP_CLIENT_ID` variable and the `RENOVATE_APP_PK_BXBVWS` secret. Dependency updates respect a one-day maturity window, use grouped Vite Plus and Changesets upgrades, and keep workflow action updates behind dashboard approval.

Vite Plus upgrades run the selected release's official migrator before installing the new dependencies. The workflow permits only the documented migration, installation, and formatting commands. Review migration findings and keep the toolchain versions aligned.
