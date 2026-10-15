#!/usr/bin/env node
import { jsonObject, isRecord } from "../packages/s3-sandbox/src/json.ts"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const configFile = path.resolve("breakage.config.json")
const config = jsonObject(readFileSync(configFile, "utf8"))
if (typeof config.tagPattern !== "string")
	throw new Error("Missing release tag pattern")
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
	const packageRoot = path.resolve("node_modules/breakage")
	const metadata = jsonObject(
		readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	)
	if (!isRecord(metadata.bin)) throw new Error("Missing executable metadata")
	const bin = metadata.bin.breakage
	if (typeof bin !== "string" || !bin)
		throw new Error("Missing breakage executable")
	const result = spawnSync(
		process.execPath,
		[path.join(packageRoot, bin), configFile, "--verbose"],
		{ stdio: "inherit" },
	)
	if (result.error) throw result.error
	process.exitCode = result.status ?? 1
}
