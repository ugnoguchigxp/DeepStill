import { combineReviews } from "../packages/memory/gaps";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { JobDetail } from "../packages/contracts";
import { CodexLlm } from "../packages/llm-provider/codex";
import { memoryPartitions } from "../packages/memory/partition";
import {
	emptyBundle,
	memorySchemas,
	memoryReviewResponse,
	validateMemory,
	allocateMemoryIds,
	memoryStageHash,
} from "../packages/memory";
import { digest } from "../packages/research/direction";
import { instructions } from "../packages/prompts";
const [inputPath, out] = process.argv.slice(2);
if (!inputPath || !out)
	throw Error("Usage: memory-fixed.ts detail.json NEW_OUTPUT_DIR");
mkdirSync(out, { recursive: false });
const detail = JSON.parse(readFileSync(inputPath, "utf8")) as JobDetail;
detail.job.config = { ...detail.job.config, researchControlVersion: 2 };
const write = (name: string, value: unknown) =>
	writeFileSync(join(out, name), JSON.stringify(value, null, 2));
const files = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard"],
	{ encoding: "utf8" },
)
	.split("\n")
	.filter((p) => /^(apps|packages|scripts|tests)\//.test(p));
write("manifest.json", {
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	sourceHashes: Object.fromEntries(
		files.map((p) => [p, digest(readFileSync(p, "utf8"))]),
	),
	inputHash: digest(detail),
	snapshotHash: digest(detail.sources),
	eventHash: digest(detail.events),
	model: "gpt-5.6-luna",
	promptHash: digest(instructions),
	split: "development",
	budget: detail.job.budget,
	webSearch: false,
	scoringVersion: "axis-case-equal-v1",
	quality: "not_run",
	resumeFrom: process.env.MEMORY_RESUME_FROM ?? null,
	startStage: Number(process.env.MEMORY_START_STAGE ?? 0),
});
let bundle = process.env.MEMORY_RESUME_FROM
		? (JSON.parse(
				readFileSync(process.env.MEMORY_RESUME_FROM, "utf8"),
			) as ReturnType<typeof emptyBundle>)
		: emptyBundle(detail),
	tokens = 0,
	requests = 0;
if (bundle.inputHash !== emptyBundle(detail).inputHash)
	throw Error("RESUME_INPUT_CHANGED");
const startStage = Number(process.env.MEMORY_START_STAGE ?? 0);
if (!Number.isInteger(startStage) || startStage < 0 || startStage > 3)
	throw Error("INVALID_START_STAGE");
const calls: unknown[] = [];
const llm = new CodexLlm();
try {
	for (const kind of (
		[
			"memory_knowledge",
			"memory_episode",
			"memory_concepts",
			"memory_review",
		] as const
	).slice(startStage)) {
		if (
			!bundle.evidence.length &&
			(kind === "memory_knowledge" || kind === "memory_concepts")
		) {
			calls.push({ kind, skipped: "zero_evidence" });
			continue;
		}
		const partitions = memoryPartitions(
			kind,
			detail,
			bundle,
			undefined,
			Number(detail.job.config.memoryContextBytes ?? 160000),
		);
		for (const [index, input] of partitions.entries()) {
			const text = JSON.stringify(input);
			if (
				tokens + Buffer.byteLength(text) + 40000 > detail.job.budget.tokens ||
				requests >= detail.job.budget.requests
			)
				throw Error("EXPERIMENT_BUDGET");
			const result = await llm.complete(
				kind,
				text,
				AbortSignal.timeout(180000),
			);
			tokens += result.usage ?? Buffer.byteLength(text) + 4096;
			requests++;
			calls.push({
				kind,
				index,
				inputHash: digest(input),
				usage: result.usage,
				audit: result.audit,
			});
			write("calls.json", calls);
			const parsed = memorySchemas[kind].parse(JSON.parse(result.text));
			if (kind === "memory_review") {
				bundle.review = combineReviews(
					index > 0 ? bundle.review : null,
					memoryReviewResponse.parse(parsed),
				);
				bundle.status = index + 1 === partitions.length ? "reviewed" : "draft";
			} else {
				const next = allocateMemoryIds({ ...bundle, ...parsed }, bundle);
				if (partitions.length > 1) {
					const merge = <T extends { id: string }>(old: T[], fresh: T[]) => [
						...old.filter((o) => !fresh.some((f) => f.id === o.id)),
						...fresh,
					];
					next.knowledge = merge(bundle.knowledge, next.knowledge);
					next.episodes = merge(bundle.episodes, next.episodes);
					next.concepts = merge(bundle.concepts, next.concepts);
					next.relations = [
						...new Map(
							[...bundle.relations, ...next.relations].map((r) => [
								JSON.stringify(r),
								r,
							]),
						).values(),
					];
				}
				bundle = next;
			}
			bundle.structuralIssues = validateMemory(bundle, detail);
			write("memory.json", bundle);
			if (bundle.structuralIssues.length)
				throw Error(`MEMORY_INVALID:${bundle.structuralIssues.join(",")}`);
			console.info(
				JSON.stringify({
					kind,
					index,
					tokens,
					requests,
					review: bundle.review,
				}),
			);
		}
		bundle.stageHashes = {
			...bundle.stageHashes,
			[kind]: memoryStageHash(kind, detail, bundle),
		};
		write("memory.json", bundle);
	}
	write("result.json", {
		tokens,
		requests,
		structuralIssues: bundle.structuralIssues,
		reviewEstimate: bundle.review,
		reuseTest: "not_run",
	});
} catch (error) {
	write("failure.json", { error: String(error), tokens, requests });
	throw error;
}
