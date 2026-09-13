import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { requireWorker } from "../packages/runtime/research-cli";
import { hash } from "../packages/crawler";
// Explicit, labelled normal-UI replay of one previously allowed snapshot. No network retrieval.
const store = new Store();
requireWorker(store);
const parent = store.detail(process.argv[2] ?? "");
const source =
	parent?.sources.find((s) => s.id === process.argv[3]) ?? parent?.sources[0];
if (
	!parent ||
	!source ||
	hash(source.text) !== source.hash ||
	(source.security as { decision?: string }).decision !== "allow"
)
	throw Error("ALLOWED_SNAPSHOT_REQUIRED");
const job = store.atomic(() => {
	const job = store.create(
		createJobSchema.parse({
			topic: parent.job.topic,
			mode: "live",
			budget: {
				tokens: 180000,
				queries: 1,
				urls: 1,
				documents: 1,
				requests: 8,
				wallMs: 600000,
			},
		}),
	);
	job.config.researchFlow = "deliverables-v1";
	job.config.deliveryReplay = {
		jobId: parent.job.id,
		sourceId: source.id,
		hash: source.hash,
	};
	store.saveJob(job);
	store.put(job.id, "source", source.id, source);
	return job;
});
console.log(
	JSON.stringify({ jobId: job.id, sourceId: source.id, replay: true }),
);
store.close();
