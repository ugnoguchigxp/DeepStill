import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CodexLlm } from "../packages/llm-provider/codex";
import type { Draft } from "../packages/research/deliverables";
import { evaluateDeliverableReplay } from "../packages/research/replay-evaluation";

const [detailArg, operationId, outputArg] = process.argv.slice(2);
if (!detailArg || !operationId || !outputArg)
	throw Error(
		"Usage: bun scripts/replay-deliverable.ts <run-detail.json> <operation-id> <output-dir>",
	);

const detailPath = resolve(detailArg);
const outputDir = resolve(outputArg);
const detail = JSON.parse(readFileSync(detailPath, "utf8"));
const operation = detail.operations?.find(
	(row: { id?: string }) => row.id === operationId,
);
if (!operation?.result?.audit?.content)
	throw Error(`OPERATION_AUDIT_NOT_FOUND: ${operationId}`);

const rawContent = operation.result.audit.content as string;
const start = rawContent.indexOf("{");
const end = rawContent.lastIndexOf("}");
if (start < 0 || end <= start) throw Error("RUNTIME_JSON_NOT_FOUND");
const input = JSON.parse(rawContent.slice(start, end + 1));
const previous = (input.draft ?? {
	sections: [],
	knowledge: [],
	limitations: [],
	openQuestions: [],
}) as Draft;

mkdirSync(outputDir, { recursive: true });
writeFileSync(
	`${outputDir}/manifest.json`,
	JSON.stringify(
		{
			kind: "fixed_source_replay",
			newWebResearch: false,
			sourceDetail: detailPath,
			sourceJobId: detail.job.id,
			sourceOperation: operationId,
			sourceSystemHash: operation.result.audit.manifest?.systemHash ?? null,
			model: detail.job.config?.llmModel,
			reasoning: detail.job.config?.reasoning,
		},
		null,
		2,
	),
);
writeFileSync(`${outputDir}/input.json`, JSON.stringify(input, null, 2));

const started = Date.now();
const result = await new CodexLlm().complete(
	"deliverable_step",
	JSON.stringify(input),
	AbortSignal.timeout(300_000),
);
const parsed = JSON.parse(result.text);
const evaluation = evaluateDeliverableReplay(
	previous,
	parsed,
	detail.sources,
	detail.job.id,
	detail.job.topic,
);
const summary = {
	...evaluation,
	newWebResearch: false,
	elapsedMs: Date.now() - started,
	tokenUsage: result.tokenUsage,
};
writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${outputDir}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
