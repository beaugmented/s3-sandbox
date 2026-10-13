import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import { execFileSync } from "node:child_process"
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
const workspaceRoot = path.resolve(packageRoot, "../..")
const manager = process.env.npm_execpath ?? "pnpm"
const pnpm = (args: string[], cwd: string) => {
	try {
		return /\.[cm]?js$/.test(manager)
			? execFileSync(process.execPath, [manager, ...args], {
					cwd,
					encoding: "utf8",
					timeout: 120000,
				})
			: execFileSync(manager, args, { cwd, encoding: "utf8", timeout: 120000 })
	} catch (error) {
		const output = error as Error & { stdout?: string; stderr?: string }
		throw new Error(
			`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`,
			{ cause: error },
		)
	}
}
let consumer: string
beforeAll(() => {
	consumer = mkdtempSync(path.join(tmpdir(), "s3-sandbox-consumer-"))
	pnpm(["run", "build"], packageRoot)
	pnpm(["pack", "--pack-destination", consumer], packageRoot)
	const tarball = readdirSync(consumer).find((file) => file.endsWith(".tgz"))
	if (!tarball) throw new Error("Expected a package tarball")
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: { "@beaugmented/s3-sandbox": `file:./${tarball}` },
		}),
	)
	pnpm(["install", "--offline", "--ignore-scripts"], consumer)
}, 120000)
afterAll(() => {
	if (consumer) rmSync(consumer, { recursive: true, force: true })
})

describe("Installed package contract", () => {
	it("imports the root API, resolves fixtures, and runs a consumer server", () => {
		const file = path.join(consumer, "consumer.ts")
		writeFileSync(
			file,
			`
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import S3Sandbox from '@beaugmented/s3-sandbox'
const directory = mkdtempSync(path.join(tmpdir(), 's3-sandbox-installed-'))
const sandbox = new S3Sandbox({ directory, address: '127.0.0.1', port: 0, silent: true, configureBuckets: [{ name: 'consumer-bucket' }] })
try {
  const { port } = await sandbox.run()
  const response = await fetch('http://127.0.0.1:' + port)
  if (!(await response.text()).includes('consumer-bucket')) throw new Error('Missing bucket')
  for (const name of ['cors', 'website']) {
    const xml = readFileSync(new URL(import.meta.resolve('@beaugmented/s3-sandbox/example/' + name + '.xml')), 'utf8')
    if (!xml.includes('Configuration')) throw new Error('Missing XML example')
  }
  console.log('consumer passed')
} finally { if (sandbox.httpServer?.listening) await sandbox.close(); rmSync(directory, { recursive: true, force: true }) }
`,
		)
		expect(
			execFileSync(process.execPath, [file], {
				cwd: consumer,
				encoding: "utf8",
			}),
		).toContain("consumer passed")
	})
	it("ships a working executable, metadata, license and documentation", () => {
		const installed = path.join(
			consumer,
			"node_modules/@beaugmented/s3-sandbox",
		)
		const metadata = JSON.parse(
			readFileSync(path.join(installed, "package.json"), "utf8"),
		) as { name: string; version: string; license: string }
		expect(metadata.name).toBe("@beaugmented/s3-sandbox")
		const cli = path.join(installed, "dist/cli.mjs")
		expect(readFileSync(cli, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
		expect(
			execFileSync(process.execPath, [cli, "--version"], {
				cwd: consumer,
				encoding: "utf8",
			}).trim(),
		).toBe(metadata.version)
		expect(
			execFileSync(process.execPath, [cli, "--help"], {
				cwd: consumer,
				encoding: "utf8",
			}),
		).toContain("--directory")
		expect(readFileSync(path.join(installed, "LICENSE"), "utf8")).toContain(
			"Mozilla Public License Version 2.0",
		)
		expect(readFileSync(path.join(installed, "NOTICE"), "utf8")).toContain(
			"Upstream S3rver material",
		)
		expect(
			readFileSync(path.join(installed, "LICENSES/MIT.txt"), "utf8"),
		).toContain("Copyright (c) 2015 Jamie Hall")
		expect(metadata.license).toBe("MPL-2.0")
		expect(readFileSync(path.join(installed, "README.md"), "utf8")).toContain(
			"@beaugmented/s3-sandbox",
		)
		expect(readFileSync(path.join(installed, "AGENTS.md"), "utf8")).toContain(
			"S3Sandbox",
		)
		expect(readdirSync(installed)).not.toContain("tests")
	})
	it("exposes strict consumer declarations without workspace dependencies", () => {
		writeFileSync(
			path.join(consumer, "types.ts"),
			`
import S3Sandbox, { type S3SandboxOptions } from '@beaugmented/s3-sandbox'
const options: S3SandboxOptions = { directory: '/tmp/data', port: 0, configureBuckets: [{ name: 'bucket' }] }
const sandbox = new S3Sandbox(options)
const running: Promise<import('node:net').AddressInfo> = sandbox.run()
const stopped: Promise<void> = sandbox.close()
const middleware: ReturnType<S3Sandbox['callback']> = sandbox.getMiddleware()
void [running, stopped, middleware]
// @ts-expect-error invalid option type must be rejected
new S3Sandbox({ port: 'bad' })
`,
		)
		pnpm(
			[
				"exec",
				"tsc",
				"--ignoreConfig",
				"--noEmit",
				"--strict",
				"--exactOptionalPropertyTypes",
				"--noUncheckedIndexedAccess",
				"--module",
				"NodeNext",
				"--target",
				"ES2024",
				path.join(consumer, "types.ts"),
			],
			workspaceRoot,
		)
	})
})
