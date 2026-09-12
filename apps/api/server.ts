import { Store } from "../../packages/db";
import { createApp } from "./app";
const store = new Store();
if (!store.ready()) throw new Error("Run bun run db:migrate");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.PORT || 4310),
	idleTimeout: 60,
	fetch: createApp(store).fetch,
});
console.info(
	JSON.stringify({ event: "api.started", url: server.url.toString() }),
);
for (const s of ["SIGINT", "SIGTERM"] as const)
	process.on(s, async () => {
		await server.stop();
		store.close();
		process.exit(0);
	});
