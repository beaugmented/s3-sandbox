import { jsonObject } from "../../src/json.ts"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import S3Sandbox from "../../src/s3rver.ts"
import { describe, expect, it, vi } from "vite-plus/test"
import { runCli } from "../../src/cli.ts"

const argv = (...args: string[]) => [process.execPath, "s3-sandbox", ...args]
describe("Public CLI contract", () => {
	it("starts a server and applies repeatable bucket configuration files", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "s3-cli-"))
		const configFile = path.join(directory, "cors.xml")
		const io = { log: vi.fn(), error: vi.fn() }
		let server: S3Sandbox | undefined
		try {
			await writeFile(
				configFile,
				"<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>",
			)
			server = await runCli(
				argv(
					"-d",
					path.join(directory, "data"),
					"-p",
					"0",
					"--configure-bucket",
					"bucket-a",
					configFile,
					"--configure-bucket",
					"bucket-b",
				),
				{ io },
			)
			expect(server).toBeInstanceOf(S3Sandbox)
			expect(
				(await server!.store.listBuckets())
					.map((bucket) => bucket.name)
					.toSorted(),
			).toEqual(["bucket-a", "bucket-b"])
			expect(
				await server!.store.getSubresource("bucket-a", "", "cors"),
			).toMatchObject({ type: "cors" })
			expect(io.log).toHaveBeenCalledWith(
				"S3 sandbox listening on %s:%d",
				expect.any(String),
				expect.any(Number),
			)
		} finally {
			await server?.close()
			await rm(directory, { recursive: true, force: true })
		}
	})
	it("passes paired TLS files and scalar options to the server", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "s3-cli-tls-"))
		const keyFile = path.join(directory, "key.pem")
		const certFile = path.join(directory, "cert.pem")
		const io = { log: vi.fn(), error: vi.fn() }
		// The factory captures TLS inputs while starting a plain local test server.
		const server = new S3Sandbox({ directory, port: 0, silent: true })
		const createServer = vi.fn(() => server)
		try {
			await Promise.all([
				writeFile(keyFile, "key bytes"),
				writeFile(certFile, "cert bytes"),
			])
			expect(
				await runCli(
					argv(
						"-d",
						directory,
						"--key",
						keyFile,
						"--cert",
						certFile,
						"--no-vhost-buckets",
						"--allow-mismatched-signatures",
					),
					{ io, createServer },
				),
			).toBe(server)
			expect(createServer).toHaveBeenCalledWith(
				expect.objectContaining({
					key: Buffer.from("key bytes"),
					cert: Buffer.from("cert bytes"),
					vhostBuckets: false,
					allowMismatchedSignatures: true,
				}),
			)
		} finally {
			await server.close()
			await rm(directory, { recursive: true, force: true })
		}
	})
	it("prints help without starting a server or creating directories", async () => {
		const io = { log: vi.fn(), error: vi.fn() }
		const createServer = vi.fn()
		await runCli(argv("--help"), { io, createServer })
		expect(io.log.mock.calls[0]?.[0]).toContain("--configure-bucket")
		expect(createServer).not.toHaveBeenCalled()
	})
	it("reports the first-release version", async () => {
		const io = { log: vi.fn(), error: vi.fn() }
		await runCli(argv("--version"), { io })
		const pkg = jsonObject(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		)
		expect(io.log).toHaveBeenCalledWith(pkg.version)
	})
	it("rejects missing directories, invalid ports and unknown options", async () => {
		await expect(runCli(argv())).rejects.toThrow("--directory")
		await expect(runCli(argv("-d", "/unused", "-p", "70000"))).rejects.toThrow()
		await expect(runCli(argv("-d", "/unused", "--unknown"))).rejects.toThrow()
	})
	it("requires complete TLS settings and valid bucket arguments", async () => {
		await expect(
			runCli(argv("-d", "/unused", "--key", "key.pem")),
		).rejects.toThrow("--key and --cert")
		await expect(runCli(argv("--configure-bucket"))).rejects.toThrow(
			"bucket name",
		)
	})
})
