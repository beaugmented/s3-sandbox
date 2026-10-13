#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// Before 1.0, a minor changeset explicitly certifies a breaking change.
const changesets = path.resolve(import.meta.dirname, "../.changeset")
const certified = readdirSync(changesets).some(
	(file) =>
		file.endsWith(".md") &&
		file !== "README.md" &&
		/^['"]?@beaugmented\/s3-sandbox['"]?: minor$/m.test(
			readFileSync(path.join(changesets, file), "utf8"),
		),
)
if (!certified)
	console.error(
		"A breaking change requires a minor changeset for @beaugmented/s3-sandbox.",
	)
process.exitCode = certified ? 0 : 1
