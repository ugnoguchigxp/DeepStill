import { createJobSchema } from "../packages/contracts";
import { Store } from "../packages/db";
import { requireWorker, waitResearch } from "../packages/runtime/research-cli";

const store = new Store();
store.migrate();
requireWorker(store);
const job = store.create(
	createJobSchema.parse({
		topic: process.argv[2] || "LLMと宗教",
		mode: "live",
		budget: {
			queries: 8,
			documents: 16,
			urls: 40,
			tokens: 1000000,
			requests: 150,
			wallMs: 7200000,
			costUsd: 5,
			depth: 2,
		},
	}),
);
console.log(JSON.stringify({ jobId: job.id, config: job.config }));
await waitResearch(store, job.id);
store.close();
