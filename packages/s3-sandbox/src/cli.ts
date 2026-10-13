#!/usr/bin/env node
import {
	cli,
	formatWarnings,
	help,
	options,
	parseBooleanOption,
	parseNumberOption,
	parseStringOption,
} from "comline"
import { mkdirSync, readFileSync } from "node:fs"
import { z } from "zod/v4"
import S3Sandbox, {
	type BucketConfiguration,
	type S3SandboxOptions,
} from "./s3rver.ts"

const definition = cli({
	cliName: "s3-sandbox",
	routeOptions: {
		"": options(
			"Run a local S3 sandbox",
			z.object({
				help: z.boolean().default(false),
				version: z.boolean().default(false),
				directory: z.string().optional(),
				address: z.string().default("localhost"),
				port: z.number().int().min(0).max(65535).default(4568),
				silent: z.boolean().default(false),
				key: z.string().optional(),
				cert: z.string().optional(),
				"service-endpoint": z.string().default("amazonaws.com"),
				"allow-mismatched-signatures": z.boolean().default(false),
				"no-vhost-buckets": z.boolean().default(false),
			}),
			{
				help: {
					flag: "h",
					parse: parseBooleanOption,
					required: false,
					example: "--help",
					description: "Show help",
				},
				version: {
					flag: "v",
					parse: parseBooleanOption,
					required: false,
					example: "--version",
					description: "Show version",
				},
				directory: {
					flag: "d",
					parse: parseStringOption,
					required: false,
					example: "--directory",
					description: "Data directory",
				},
				address: {
					flag: "a",
					parse: parseStringOption,
					required: false,
					example: "--address",
					description: "Address to bind to",
				},
				port: {
					flag: "p",
					parse: parseNumberOption,
					required: false,
					example: "--port",
					description: "HTTP port (0 selects an available port)",
				},
				silent: {
					flag: "s",
					parse: parseBooleanOption,
					required: false,
					example: "--silent",
					description: "Suppress request logging",
				},
				key: {
					parse: parseStringOption,
					required: false,
					example: "--key",
					description: "TLS private key file",
				},
				cert: {
					parse: parseStringOption,
					required: false,
					example: "--cert",
					description: "TLS certificate file",
				},
				"service-endpoint": {
					parse: parseStringOption,
					required: false,
					example: "--service-endpoint",
					description: "Service hostname suffix",
				},
				"allow-mismatched-signatures": {
					parse: parseBooleanOption,
					required: false,
					example: "--allow-mismatched-signatures",
					description: "Accept mismatched signatures",
				},
				"no-vhost-buckets": {
					parse: parseBooleanOption,
					required: false,
					example: "--no-vhost-buckets",
					description: "Disable bucket hostnames",
				},
			},
		),
	},
})

export type CliEnvironment = {
	io?: Pick<Console, "log" | "error">
	readFile?: typeof readFileSync
	mkdir?: typeof mkdirSync
	createServer?: (options: S3SandboxOptions) => S3Sandbox
}

/** Handle repeatable bucket/config groups before scalar option parsing. */
function bucketArguments(argv: string[], readFile: typeof readFileSync) {
	const args = argv.slice(0, 2)
	const buckets: BucketConfiguration[] = []
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] !== "--configure-bucket") {
			args.push(argv[i]!)
			continue
		}
		const name = argv[++i]
		if (!name || name.startsWith("-"))
			throw new Error("--configure-bucket requires a bucket name")
		const configs: Buffer[] = []
		while (argv[i + 1] && !argv[i + 1]!.startsWith("-"))
			configs.push(readFile(argv[++i]!) as Buffer)
		buckets.push({ name, configs })
	}
	return { args, buckets }
}

export async function runCli(
	argv = process.argv,
	environment: CliEnvironment = {},
): Promise<S3Sandbox | undefined> {
	const io = environment.io ?? console
	const readFile = environment.readFile ?? readFileSync
	const { args, buckets } = bucketArguments(argv, readFile)
	const { inputs, warnings } = definition(args)
	if (warnings.length)
		throw new Error(formatWarnings(warnings, { forceColor: false }))
	const opts = inputs.opts
	if (opts.help) {
		io.log(
			help(definition.definition) +
				"\n  --configure-bucket <name> [configs...]  Preconfigure a bucket (repeatable)",
		)
		return
	}
	if (opts.version) {
		io.log(
			(
				JSON.parse(
					readFile(new URL("../package.json", import.meta.url), "utf8"),
				) as { version: string }
			).version,
		)
		return
	}
	if (!opts.directory)
		throw new Error("Missing required option: --directory <path>")
	if (Boolean(opts.key) !== Boolean(opts.cert))
		throw new Error("--key and --cert must be supplied together")
	const configs: S3SandboxOptions = {
		directory: opts.directory,
		address: opts.address,
		port: opts.port,
		silent: opts.silent,
		serviceEndpoint: opts["service-endpoint"],
		allowMismatchedSignatures: opts["allow-mismatched-signatures"],
		vhostBuckets: !opts["no-vhost-buckets"],
		configureBuckets: buckets,
		...(opts.key && opts.cert
			? { key: readFile(opts.key), cert: readFile(opts.cert) }
			: {}),
	}
	;(environment.mkdir ?? mkdirSync)(opts.directory, { recursive: true })
	const server = (
		environment.createServer ?? ((options) => new S3Sandbox(options))
	)(configs)
	const { address, port } = await server.run()
	io.log("S3 sandbox listening on %s:%d", address, port)
	return server
}

if (import.meta.main) {
	try {
		await runCli()
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	}
}
