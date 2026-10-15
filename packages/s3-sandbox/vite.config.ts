import { defineConfig } from "vite-plus"
export default defineConfig({
	pack: [
		{
			clean: true,
			entry: { s3rver: "src/s3rver.ts", cli: "src/cli.ts" },
			format: "esm",
			outDir: "dist",
			sourcemap: true,
			deps: {
				// tsdown <0.23 compatibility: resolve external dependency subpaths.
				// Remove to preserve subpath imports as written (the new default).
				// https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
				resolveDepSubpath: true,
				neverBundle: true,
				onlyBundle: [],
				// Keep dependencies external without excluding Windows drive paths.
				dts: { neverBundle: true },
			},
			dts: { entry: ["src/s3rver.ts"], sourcemap: true },
			// Native Temporal appears in the public storage API.
			banner: {
				dts: '/// <reference types="node" />\n/// <reference lib="esnext.temporal" />',
			},
			publint: true,
		},
	],
	test: {
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/public/setup.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts"],
			exclude: ["src/types.ts"],
		},
	},
})
