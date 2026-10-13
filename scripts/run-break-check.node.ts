#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const configFile = path.resolve("break-check.config.json")
const config = JSON.parse(readFileSync(configFile, "utf8")) as {
	tagPattern: string
}
const tags = execFileSync(
	"git",
	["ls-remote", "--tags", "origin", `${config.tagPattern}*`],
	{ encoding: "utf8" },
)
if (!tags.trim()) {
	console.log(
		"No scoped-package release exists yet; historical compatibility checks begin after the first release.",
	)
} else {
	const packageRoot = path.resolve("node_modules/break-check")
	const metadata = JSON.parse(
		readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	) as { bin: Record<string, string> }
	const bin = metadata.bin["break-check"]
	if (!bin) throw new Error("Missing break-check executable")
	const result = spawnSync(
		process.execPath,
		[path.join(packageRoot, bin), configFile, "--verbose"],
		{ stdio: "inherit" },
	)
	if (result.error) throw result.error
	process.exitCode = result.status ?? 1
}
