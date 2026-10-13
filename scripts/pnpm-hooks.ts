type PackageManifest = {
	name?: string
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

// Vite Plus's declaration bundler requires the TypeScript 6 compiler API.
// The workspace compiler remains TypeScript 7, matching lasertag.
export const hooks = {
	readPackage(pkg: PackageManifest): PackageManifest {
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
