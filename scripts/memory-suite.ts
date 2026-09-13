import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { reuseCaseSchema, summarizeReuse } from "../packages/memory/harness";

const [
	detailPath,
	memoryPath,
	casesPath,
	outputPath,
	split = "development",
	runsText = "1",
] = process.argv.slice(2);
const runs = Number(runsText);
if (
	!outputPath ||
	!["development", "holdout"].includes(split) ||
	!Number.isInteger(runs) ||
	runs < 1 ||
	runs > 3
)
	throw Error(
		"Usage: memory-suite.ts detail.json memory.json cases.json NEW_DIR development|holdout 1..3",
	);
const out = resolve(outputPath);
mkdirSync(out, { recursive: false });
const cases = reuseCaseSchema
	.array()
	.parse(JSON.parse(readFileSync(casesPath, "utf8")))
	.filter((c) => c.split === split);
if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
	throw Error("INVALID_CASE_SET");
const detail = JSON.parse(readFileSync(detailPath, "utf8"));
const batchSize = 5;
const batches = Array.from(
	{ length: Math.ceil(cases.length / batchSize) },
	(_, i) => cases.slice(i * batchSize, (i + 1) * batchSize),
);
const write = (name: string, value: unknown) =>
	writeFileSync(join(out, name), JSON.stringify(value, null, 2));
write("manifest.json", {
	split,
	runs,
	batchSize,
	caseIds: cases.map((c) => c.id),
	memoryHash: createHash("sha256")
		.update(readFileSync(memoryPath))
		.digest("hex"),
	casesHash: createHash("sha256").update(readFileSync(casesPath)).digest("hex"),
	perBatchBudget: detail.job.budget,
	totalTokenCeiling: runs * batches.length * detail.job.budget.tokens,
	policy:
		"Sequential independent evaluation batches; no research job budget changes, no retries, no case exclusion. All batch budgets declared before the first call.",
});
for (let run = 1; run <= runs; run++) {
	const results: Parameters<typeof summarizeReuse>[0] = [];
	for (const [index, batch] of batches.entries()) {
		const batchCases = join(out, `cases-${index + 1}.json`);
		writeFileSync(batchCases, JSON.stringify(batch, null, 2));
		const batchOut = join(out, `run-${run}-batch-${index + 1}`);
		const child = spawn(
			process.execPath,
			[
				"scripts/memory-reuse.ts",
				resolve(detailPath),
				resolve(memoryPath),
				batchCases,
				batchOut,
				split,
				"1",
			],
			{ stdio: "inherit", env: { ...process.env, MEMORY_AUTHORED_QUERY: "0" } },
		);
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		let completed: typeof results = [];
		try {
			completed = JSON.parse(
				readFileSync(join(batchOut, "run-1.json"), "utf8"),
			).results;
		} catch {
			/* failed before first completed case */
		}
		results.push(...completed);
		write(`run-${run}.json`, {
			complete: results.length === cases.length,
			results,
			summary: summarizeReuse(results),
		});
		if (code !== 0 || completed.length !== batch.length) {
			write("failure.json", {
				run,
				batch: index + 1,
				code,
				completed: results.length,
			});
			throw Error("SUITE_BATCH_FAILED");
		}
	}
	console.info(JSON.stringify({ run, summary: summarizeReuse(results) }));
}
