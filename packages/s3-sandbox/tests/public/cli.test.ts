import { jsonObject } from "../../src/json.ts"
import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vite-plus/test"
import { runCli } from "../../src/cli.ts"

const argv = (...args: string[]) => [process.execPath, "s3-sandbox", ...args]
describe("Public CLI contract", () => {
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
