import { changesetsReleaseDelta } from "@breakage/changesets"
import { defineConfig, semverPolicy } from "breakage"

export default defineConfig({
	tagPattern: "refs/tags/@beaugmented/s3-sandbox@",
	testPattern: "tests/public/**",
	test: "pnpm run test:public",
	release: {
		resolveDelta: changesetsReleaseDelta(),
		policy: semverPolicy({ beforeV1: "minor" }),
	},
})
