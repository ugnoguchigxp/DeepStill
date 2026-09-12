import { Store } from "../packages/db";
import { requireWorker, waitResearch } from "../packages/runtime/research-cli";

const store = new Store();
try {
	requireWorker(store);
	const id = process.argv[2];
	store.queueMaintenance(id, "review");
	await waitResearch(store, id);
} finally {
	store.close();
}
