// Vite Plus's declaration bundler still requires the TypeScript 6 compiler API.
// The workspace itself uses TypeScript 7, matching lasertag.
export const hooks = {
	readPackage(pkg) {
		if (
			pkg.name === "@voidzero-dev/vite-plus-core" &&
			pkg.peerDependencies?.typescript
		) {
			delete pkg.peerDependencies.typescript
			delete pkg.peerDependenciesMeta?.typescript
			pkg.dependencies = { ...pkg.dependencies, typescript: "6.0.3" }
		}
		return pkg
	},
}
