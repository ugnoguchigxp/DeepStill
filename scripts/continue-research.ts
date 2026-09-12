import { canonicalUrl } from "../packages/core";
import { Store } from "../packages/db";
import { requireWorker, waitResearch } from "../packages/runtime/research-cli";

const store = new Store();
requireWorker(store);
const id = process.argv[2];
const job = store.getJob(id);
if (!job || !["partial", "completed"].includes(job.status))
	throw new Error("FINISHED_JOB_REQUIRED");
if (job.config.engineVersion === 2) {
	if (process.argv.length > 3) {
		const { createJobSchema } = await import("../packages/contracts");
		const next = store.create(
			createJobSchema.parse({
				topic: job.topic,
				mode: job.mode,
				budget: job.budget,
			}),
		);
		for (const question of process.argv.slice(3))
			store.addExploration(
				next.id,
				crypto.randomUUID(),
				store.research(next.id).revision,
				question,
				"supplement",
			);
		await waitResearch(store, next.id);
	} else {
		store.queueMaintenance(id, "edit");
		await waitResearch(store, id);
	}
	store.close();
	process.exit(0);
}
if (Date.now() >= (job.deadline || 0)) throw new Error("DEADLINE_EXPIRED");
const hits = process.argv.slice(3).map((url, i) => ({
	url: canonicalUrl(url),
	title: "Explicit supplementary source",
	snippet: "Operator identified coverage gap",
	rank: i + 1,
}));
store.atomic(() => {
	const task = store.sql
		.query("SELECT state FROM tasks WHERE job_id=?")
		.get(id) as { state: string };
	if (task.state !== "done") throw new Error("TASK_STILL_ACTIVE");
	job.status = "running";
	job.reason = "quality_revision";
	job.config.generationAttempt = Number(job.config.generationAttempt || 0) + 1;
	store.saveJob(job);
	const state = {
		phase: hits.length ? "crawl" : "finalize",
		round: 0,
		lowGain: 0,
		index: 0,
		hits,
		before: store.detail(id)?.claims.filter((c) => c.accepted).length || 0,
		successes: 0,
	};
	store.sql
		.query(
			"UPDATE tasks SET state='pending',payload=?,next_at=0,token='',lease_until=0 WHERE job_id=?",
		)
		.run(JSON.stringify(state), id);
	store.event(id, "job.quality_revision_started", {
		hits,
		generationAttempt: job.config.generationAttempt,
	});
});
await waitResearch(store, id);
store.close();
