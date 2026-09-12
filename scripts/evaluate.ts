import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
import { Engine, mocks } from "../apps/worker/engine";
import { createJobSchema } from "../packages/contracts";
import { terminal } from "../packages/core";
import { validateClaims } from "../packages/artifact";
const dir = mkdtempSync(join(tmpdir(), "deepstill-eval-"));
const store = new Store(join(dir, "eval.sqlite"));
store.migrate();
const engine = new Engine(store, () => mocks, join(dir, "artifacts"));
const count = Number(process.argv[2] || 100);
if (!Number.isInteger(count) || count < 1 || count > 1000)
	throw new Error("count must be 1..1000");
let completed = 0,
	claims = 0,
	tokens = 0;
const started = Date.now();
for (let n = 0; n < count; n++) {
	const j = store.create(
		createJobSchema.parse({
			topic: `Evidence fixture evaluation ${n}`,
			strategy: n % 2 ? "balanced" : "diverse",
		}),
	);
	for (let i = 0; i < 200 && !terminal(store.getJob(j.id)?.status ?? ""); i++)
		await engine.tick();
	const d = store.detail(j.id);
	if (d?.job.status !== "completed")
		throw new Error(`Evaluation failed: ${j.id} ${d?.job.reason}`);
	validateClaims(d, d.artifacts[0].claimIds);
	completed++;
	claims += d.claims.filter((c) => c.accepted).length;
	tokens += d.job.usage.tokens;
}
store.close();
const report = {
	mode: "deterministic-fixture",
	notLiveResearch: true,
	jobs: count,
	completed,
	claims,
	tokens,
	elapsedMs: Date.now() - started,
	adoptionRate: null,
	realWorldQuality: null,
	workspace: dir,
};
mkdirSync("data", { recursive: true });
writeFileSync("data/evaluation.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
