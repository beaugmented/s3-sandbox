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
				neverBundle: true,
				onlyBundle: [],
				dts: { neverBundle: [/^[\w@]/] },
			},
			dts: { entry: ["src/s3rver.ts"], sourcemap: true },
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
