import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { JobDetail } from "../packages/contracts";
import { CodexLlm } from "../packages/llm-provider/codex";
import {
	memoryContext,
	emptyBundle,
	memoryInput,
	memorySchemas,
	memoryReviewResponse,
	validateMemory,
	type MemoryBundle,
} from "../packages/memory";
import {
	reuseCaseSchema,
	runReuseCase,
	summarizeReuse,
} from "../packages/memory/harness";
// Explicit local artifact input; never triggers a new web search or external memory write.
const [
	detailPath,
	outputDir,
	casesPath,
	split = "development",
	runsText = "1",
] = process.argv.slice(2);
if (!detailPath || !outputDir)
	throw new Error(
		"Usage: bun scripts/memory-evaluate.ts detail.json NEW_OUTPUT_DIR [cases.json development|holdout runs]",
	);
if (!["development", "holdout"].includes(split))
	throw new Error("INVALID_SPLIT");
const runs = Number(runsText);
if (!Number.isInteger(runs) || runs < 1 || runs > 3)
	throw new Error("RUNS_1_TO_3");
mkdirSync(outputDir, { recursive: false });
const detail = (await Bun.file(detailPath).json()) as JobDetail;
const input = memoryInput(detail);
const llm = new CodexLlm();
const signal = AbortSignal.timeout(30 * 60 * 1000);
let bundle: MemoryBundle = process.env.MEMORY_RESUME_FROM
	? await Bun.file(process.env.MEMORY_RESUME_FROM).json()
	: emptyBundle(detail);
if (bundle.inputHash !== input.inputHash)
	throw new Error("MEMORY_RESUME_INPUT_CHANGED");
const startStage = Number(process.env.MEMORY_START_STAGE ?? 0);
if (!Number.isInteger(startStage) || startStage < 0 || startStage > 3)
	throw new Error("INVALID_START_STAGE");
const audits: unknown[] = [];
for (const kind of (
	[
		"memory_knowledge",
		"memory_episode",
		"memory_concepts",
		"memory_review",
	] as const
).slice(startStage)) {
	const data = memoryContext(kind, detail, bundle);
	if (JSON.stringify(data).length > 160000)
		throw new Error("MEMORY_CONTEXT_LIMIT");
	const result = await llm.complete(kind, JSON.stringify(data), signal);
	const parsed = memorySchemas[kind].parse(JSON.parse(result.text));
	if (kind === "memory_review") {
		bundle.review = memoryReviewResponse.parse(parsed);
		bundle.status = "reviewed";
	} else bundle = { ...bundle, ...parsed };
	bundle.structuralIssues = validateMemory(bundle, detail);
	audits.push({
		kind,
		usage: result.usage,
		audit: result.audit,
		issues: bundle.structuralIssues,
	});
	writeFileSync(
		join(outputDir, "memory.json"),
		JSON.stringify(bundle, null, 2),
	);
	writeFileSync(join(outputDir, "audit.json"), JSON.stringify(audits, null, 2));
	console.info(
		JSON.stringify({
			kind,
			issues: bundle.structuralIssues,
			review: bundle.review,
		}),
	);
	if (bundle.structuralIssues.length)
		throw new Error("MEMORY_VALIDATION_FAILED");
}
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
writeFileSync(
	join(outputDir, "manifest.json"),
	JSON.stringify(
		{
			detailPath,
			inputHash: input.inputHash,
			detailHash: hash(await Bun.file(detailPath).text()),
			casesHash: casesPath ? hash(await Bun.file(casesPath).text()) : null,
			split,
			runs,
			webSearch: false,
		},
		null,
		2,
	),
);
if (casesPath) {
	const cases = reuseCaseSchema
		.array()
		.parse(await Bun.file(casesPath).json())
		.filter((c) => c.split === split);
	if (!cases.length) throw new Error("NO_CASES_FOR_SPLIT");
	for (let run = 1; run <= runs; run++) {
		const results = [];
		for (const c of cases) {
			results.push(await runReuseCase(bundle, detail, c, llm, signal));
			writeFileSync(
				join(outputDir, `reuse-${run}.json`),
				JSON.stringify({ results, summary: summarizeReuse(results) }, null, 2),
			);
			console.info(
				JSON.stringify({ run, case: c.id, score: results.at(-1)?.score }),
			);
		}
	}
} else
	console.info(
		"No authored reuse cases supplied. Review scores do not establish reuse quality.",
	);
