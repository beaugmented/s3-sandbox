#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const dryRun = process.argv.includes("--dry-run")
const root = path.resolve(import.meta.dirname, "..")
function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? files(path.join(directory, entry.name))
			: [path.join(directory, entry.name)],
	)
}
const cache = new Map<string, { version: string; sha: string }>()
function latest(action: string) {
	const previous = cache.get(action)
	if (previous) return previous
	const lines = execFileSync(
		"git",
		["ls-remote", "--tags", `https://github.com/${action}.git`],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
	const tags = lines
		.flatMap((line) => {
			const match =
				/^(?<sha>[a-f0-9]{40})\s+refs\/tags\/(?<tag>v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+))(?<peeled>\^\{\})?$/.exec(
					line,
				)
			return match?.groups
				? [
						{
							sha: match.groups.sha,
							tag: match.groups.tag,
							peeled: match.groups.peeled,
							numbers: [
								Number(match.groups.major),
								Number(match.groups.minor),
								Number(match.groups.patch),
							],
						},
					]
				: []
		})
		.toSorted((a, b) => {
			for (let i = 0; i < 3; i++) {
				const difference = b.numbers[i]! - a.numbers[i]!
				if (difference) return difference
			}
			return Number(Boolean(b.peeled)) - Number(Boolean(a.peeled))
		})
	const tag = tags[0]
	if (!tag?.sha || !tag.tag)
		throw new Error(`No stable release found for ${action}`)
	const result = { version: tag.tag, sha: tag.sha }
	cache.set(action, result)
	return result
}
for (const file of files(path.join(root, ".github")).filter((candidate) =>
	/\.ya?ml$/.test(candidate),
)) {
	const original = readFileSync(file, "utf8")
	const updated = original.replace(
		/(uses:\s+)([\w.-]+\/[\w.-]+)@([a-f0-9]{40})\s+#\s*v?[\d.]+/g,
		(_match, prefix: string, action: string, current: string) => {
			const target = latest(action)
			console.log(
				`${action}: ${current.slice(0, 7)} -> ${target.sha.slice(0, 7)} (${target.version})`,
			)
			return `${prefix}${action}@${target.sha} # ${target.version}`
		},
	)
	if (!dryRun && updated !== original) writeFileSync(file, updated)
}
// mise itself is pinned independently from its GitHub Action.
const setup = path.join(root, ".github/actions/setup/action.yml")
const text = readFileSync(setup, "utf8")
const target = latest("jdx/mise").version.replace(/^v/, "")
if (!dryRun)
	writeFileSync(
		setup,
		text.replace(/(version:\s*)\d+\.\d+\.\d+/, `$1${target}`),
	)
console.log(`mise: ${target}${dryRun ? " (dry run)" : ""}`)
