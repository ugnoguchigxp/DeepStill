import { tokenReservation } from "../packages/llm-provider";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { instructions } from "../packages/prompts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexLlm } from "../packages/llm-provider/codex";
import {
	reuseCaseSchema,
	runReuseCase,
	summarizeReuse,
} from "../packages/memory/harness";
import type { MemoryBundle } from "../packages/memory";
import type { JobDetail } from "../packages/contracts";
const [
	detailPath,
	memoryPath,
	casesPath,
	out,
	split = "development",
	runsText = "1",
] = process.argv.slice(2);
if (!out || !["development", "holdout"].includes(split))
	throw Error(
		"Usage: memory-reuse.ts detail.json memory.json cases.json NEW_DIR [development|holdout] [1..3]",
	);
const runs = Number(runsText);
if (!Number.isInteger(runs) || runs < 1 || runs > 3)
	throw Error("INVALID_RUNS");
mkdirSync(out, { recursive: false });
const detail = (await Bun.file(detailPath).json()) as JobDetail;
const memory = (await Bun.file(memoryPath).json()) as MemoryBundle;
const cases = reuseCaseSchema
	.array()
	.parse(await Bun.file(casesPath).json())
	.filter((c) => c.split === split);
if (!cases.length) throw Error("NO_CASES");
if (split === "holdout") {
	const development = reuseCaseSchema
		.array()
		.parse(
			await Bun.file(
				new URL(
					"../tests/fixtures/memory/llm-web-development-v2.json",
					import.meta.url,
				),
			).json(),
		);
	if (cases.some((c) => development.some((d) => d.id === c.id)))
		throw Error(
			"HOLDOUT_PROVENANCE_UNVERIFIED: v1 cases are development; register unused cases before claiming holdout results",
		);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sourceFiles = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard"],
	{ encoding: "utf8" },
)
	.split("\n")
	.filter((p) => /^(apps|packages|scripts|tests)\//.test(p));
writeFileSync(
	join(out, "manifest.json"),
	JSON.stringify(
		{
			head: execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
			sourceHashes: Object.fromEntries(
				sourceFiles.map((p) => [p, hash(readFileSync(p, "utf8"))]),
			),
			diffHash: hash(
				execFileSync("git", ["diff", "--binary"], { encoding: "utf8" }),
			),
			promptHash: hash(JSON.stringify(instructions)),
			snapshotHash: hash(JSON.stringify(detail.sources)),
			eventHash: hash(JSON.stringify(detail.events)),
			retrievalMode:
				process.env.MEMORY_AUTHORED_QUERY === "1"
					? "authored-query"
					: "question-driven",
			schemaVersion: "memory-v1/control-v2",
			detailPath,
			memoryPath,
			casesPath,
			split,
			runs,
			caseIds: cases.map((c) => c.id),
			memoryHash: hash(await Bun.file(memoryPath).text()),
			casesHash: hash(await Bun.file(casesPath).text()),
			model: "gpt-5.6-luna",
			reasoning: "low",
			webSearch: false,
			budget: detail.job.budget,
			inputHash: hash(JSON.stringify(detail)),
			scoringVersion: "axis-case-equal-v1",
		},
		null,
		2,
	),
);
const live = new CodexLlm();
const replay = process.env.MEMORY_REPLAY_ANSWERS
	? ((await Bun.file(process.env.MEMORY_REPLAY_ANSWERS).json()) as {
			results: { caseId: string; answer: unknown }[];
		})
	: null;
let currentCase = "";
const calls: unknown[] = [];
let totalTokens = 0,
	totalCalls = 0;
const llm: import("../packages/llm-provider").LlmProvider = {
	async complete(kind, input, signal) {
		if (kind === "memory_probe" && replay) {
			const row = replay.results.find((r) => r.caseId === currentCase);
			if (!row) throw Error("REPLAY_CASE_MISSING");
			return {
				text: JSON.stringify(row.answer),
				usage: 0,
				audit: {
					replay: process.env.MEMORY_REPLAY_ANSWERS,
					caseId: currentCase,
				},
			};
		}
		const reserve = tokenReservation(input, kind) + 20000;
		if (
			totalTokens + reserve > detail.job.budget.tokens ||
			totalCalls >= detail.job.budget.requests
		)
			throw Error("REUSE_BUDGET_EXHAUSTED");
		totalCalls++;
		try {
			const result = await live.complete(kind, input, signal);
			totalTokens += result.usage ?? reserve;
			calls.push({ kind, caseId: currentCase, inputHash: hash(input), result });
			writeFileSync(join(out, "calls.json"), JSON.stringify(calls, null, 2));
			return result;
		} catch (error) {
			writeFileSync(
				join(out, "failure.json"),
				JSON.stringify(
					{
						caseId: currentCase,
						error: String(error),
						totalTokens,
						totalCalls,
					},
					null,
					2,
				),
			);
			throw error;
		}
	},
};
for (let run = 1; run <= runs; run++) {
	const results = [];
	for (const c of cases) {
		currentCase = c.id;
		results.push(
			await runReuseCase(memory, detail, c, llm, AbortSignal.timeout(360000), {
				interactive: process.env.MEMORY_AUTHORED_QUERY !== "1",
			}),
		);
		const summary = summarizeReuse(results);
		writeFileSync(
			join(out, `run-${run}.json`),
			JSON.stringify({ results, summary }, null, 2),
		);
		console.info(
			JSON.stringify({
				run,
				case: c.id,
				score: results.at(-1)?.score,
				critical: results.at(-1)?.criticalFailure,
			}),
		);
	}
}
