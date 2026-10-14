import type { Hono } from "hono"
import { getRequestListener, type HttpBindings } from "@hono/node-server"
import type { RequestListener } from "node:http"

/** Bridge a Hono app to Node's synchronous request event and handle failures. */
export function createHonoListener(
	app: Hono<{ Bindings: HttpBindings }>,
): RequestListener {
	const handle = getRequestListener(app.fetch, { overrideGlobalObjects: false })
	return (incoming, outgoing) => {
		void handle(incoming, outgoing).catch((error: unknown) => {
			outgoing.destroy(
				error instanceof Error ? error : new Error(String(error)),
			)
		})
	}
}
