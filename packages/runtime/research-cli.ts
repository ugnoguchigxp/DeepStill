import { terminal } from "../core";
import type { Store } from "../db";
import { workerHealth } from "./index";
export function requireWorker(store: Store) {
	if (!workerHealth(store.path).ready)
		throw new Error(
			"WORKER_REQUIRED: bun run dev または bun run worker を起動してください",
		);
}
export async function waitResearch(store: Store, id: string) {
	let last = 0;
	while (!terminal(store.getJob(id)?.status ?? "")) {
		for (const e of store.events(id, last)) {
			console.log(JSON.stringify(e));
			last = e.id;
		}
		if (!workerHealth(store.path).ready)
			throw new Error("WORKER_UNAVAILABLE: キューは保存されています");
		await Bun.sleep(1000);
	}
	console.log(JSON.stringify(store.getJob(id)));
}
