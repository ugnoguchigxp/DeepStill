import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../packages/db";
import { Engine } from "../apps/worker/engine";
import { configuredProviders } from "../apps/worker/main";
import { createJobSchema, type JobDetail } from "../packages/contracts";
import { terminal } from "../packages/core";
import { digest } from "../packages/research/direction";
import { instructions } from "../packages/prompts";
const [inputPath, outputPath, mode = "live"] = process.argv.slice(2);
if (!inputPath || !outputPath || !["live", "resume"].includes(mode))
	throw Error(
		"Usage: memory-experiment.ts baseline-detail.json NEW_OUTPUT_DIR live|resume",
	);
const baseline = (await Bun.file(inputPath).json()) as JobDetail;
const out = resolve(outputPath);
mkdirSync(out, { recursive: false });
if (mode === "resume") {
	const source = new Database(
		join(dirname(resolve(inputPath)), "experiment.db"),
		{ readonly: true },
	);
	try {
		writeFileSync(join(out, "experiment.db"), source.serialize());
	} finally {
		source.close();
	}
}
const store = new Store(join(out, "experiment.db"));
store.migrate();
const job =
	mode === "resume"
		? store.getJob(baseline.job.id)!
		: store.create(
				createJobSchema.parse({
					topic: baseline.job.topic,
					mode: "live",
					budget: baseline.job.budget,
				}),
			);
job.config = {
	...baseline.job.config,
	memoryVersion: 1,
	researchControlVersion: 2,
	actionCandidateLimit: 3,
};
store.saveJob(job);
const write = (name: string, value: unknown) =>
	writeFileSync(join(out, name), JSON.stringify(value, null, 2));
const files = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard"],
	{ encoding: "utf8" },
)
	.split("\n")
	.filter((p) => /^(apps|packages|scripts|tests)\//.test(p));
const manifest = {
	sourceHashes: Object.fromEntries(
		files.map((p) => [p, digest(readFileSync(p, "utf8"))]),
	),
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	diffHash: digest(
		execFileSync("git", ["diff", "--binary"], { encoding: "utf8" }),
	),
	inputHash: digest(baseline),
	snapshotHash: digest(baseline.sources),
	eventHash: digest(baseline.events),
	config: job.config,
	budget: job.budget,
	promptHash: digest(instructions),
	schemaVersion: "memory-v1/control-v2",
	scoringVersion: "axis-case-equal-v1",
	split: "development",
	mode,
	startedAt: new Date().toISOString(),
	quality: "not_run",
	localLlm: "not_run",
	externalAdapter: "dry_run_only",
};
write("manifest.json", manifest);
const providers = configuredProviders(job);
if (mode === "resume") {
	if (store.slot().state !== "idle")
		throw Error("RESUME_REQUIRES_SETTLED_EXTERNAL_SLOT");
	const state = store.research(job.id);
	const round = state.rounds.at(-1);
	if (!round) throw Error("REPLAY_ROUND_MISSING");
	job.status = "running";
	job.reason = "";
	store.saveJob(job);
	store.put(job.id, "research", "state", {
		id: "state",
		revision: state.revision + 1,
		sufficient: false,
		reason: "resume_after_control_fix",
	});
	const id = crypto.randomUUID();
	store.saveWork({
		id,
		jobId: job.id,
		roundId: round.id,
		kind: "evaluate",
		status: "pending",
		priority: 0,
		reason: "Resume from recorded failure",
		revision: 0,
		nextAt: 0,
		dependsOn: [],
		payload: {},
		createdAt: Date.now(),
	});
	store.sql
		.query("UPDATE tasks SET state='pending',next_at=0 WHERE job_id=?")
		.run(job.id);
}

const engine = new Engine(store, () => providers, join(out, "artifacts"));
let ticks = 0;
try {
	while (!terminal(store.getJob(job.id)?.status ?? "")) {
		if (++ticks > 2000) throw Error("EXPERIMENT_TICK_LIMIT");
		await engine.tick(job.id);
		const detail = store.detail(job.id)!;
		write("detail.json", detail);
		const work = detail.research?.items.find(
			(w) => w.status === "running" || w.status === "pending",
		);
		console.info(
			JSON.stringify({
				ticks,
				status: detail.job.status,
				kind: work?.kind,
				usage: detail.job.usage,
			}),
		);
		if (["unknown", "blocked"].includes(detail.research?.slot?.state ?? ""))
			throw Error("EXTERNAL_RESULT_UNKNOWN");
		await Bun.sleep(100);
	}
	write("result.json", {
		status: store.getJob(job.id)?.status,
		reason: store.getJob(job.id)?.reason,
		usage: store.getJob(job.id)?.usage,
		quality: "not_run",
	});
} catch (error) {
	write("failure.json", { error: String(error), ticks });
	throw error;
} finally {
	write("detail.json", store.detail(job.id));
	await providers.crawler.close();
	store.close();
}
