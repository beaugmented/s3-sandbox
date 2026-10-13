import { defineConfig } from "vite-plus"

export default defineConfig({
	lint: {
		ignorePatterns: [
			"**/dist/**",
			"**/node_modules/**",
			"**/tests/public/fixtures/**",
		],
		overrides: [
			{
				files: ["**/tests/**/*.ts"],
				rules: { "eslint/no-unused-expressions": "off" },
			},
		],
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		rules: { "vite-plus/prefer-vite-plus-imports": "error" },
		options: { typeAware: true, typeCheck: true },
	},
	staged: { "*": ["dprint fmt", "vp check --no-fmt --fix"] },
})
