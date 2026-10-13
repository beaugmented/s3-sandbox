import { defineConfig } from "vite-plus"

export default defineConfig({
	lint: {
		categories: { correctness: "error", suspicious: "error", perf: "error" },
		plugins: ["typescript", "unicorn", "oxc", "import", "promise", "node"],
		ignorePatterns: [
			"**/dist/**",
			"**/node_modules/**",
			"**/tests/public/fixtures/**",
		],
		overrides: [
			{
				// These legacy XML consumers retain the parser's scalar/array coercions.
				// Track schema normalization in docs/implementation-review.md before removing this exception.
				files: [
					"packages/s3-sandbox/src/models/config.ts",
					"packages/s3-sandbox/src/models/routing-rule.ts",
				],
				rules: {
					"typescript/no-unsafe-assignment": "off",
					"typescript/no-unsafe-member-access": "off",
					"typescript/no-unsafe-argument": "off",
					"typescript/no-unsafe-return": "off",
					"typescript/no-unsafe-call": "off",
				},
			},
			{
				// Koa middleware factories intentionally create a handler per registration.
				files: ["packages/s3-sandbox/src/middleware/*.ts"],
				rules: { "unicorn/consistent-function-scoping": "off" },
			},
			{
				files: ["**/tests/**/*.ts"],
				rules: { "eslint/no-unused-expressions": "off" },
			},
		],
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		rules: {
			"import/no-duplicates": "error",
			"vite-plus/prefer-vite-plus-imports": "error",
			"typescript/no-explicit-any": "error",
			"typescript/no-floating-promises": "error",
			"typescript/no-misused-promises": "error",
			"typescript/await-thenable": "error",
			"typescript/no-unsafe-assignment": "error",
			"typescript/no-unsafe-member-access": "error",
			"typescript/no-unsafe-call": "error",
			"typescript/no-unsafe-argument": "error",
			"typescript/no-unsafe-return": "error",
			"eslint/no-restricted-globals": [
				"error",
				{
					name: "Date",
					message: "Use Temporal and the protocol timestamp helpers.",
				},
			],
		},
		options: { typeAware: true, typeCheck: true },
	},
	staged: { "*": ["dprint fmt", "vp check --no-fmt --fix"] },
})
