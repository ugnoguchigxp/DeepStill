import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexLlm } from "../packages/llm-provider/codex";
import {
	fulfillmentInput,
	validateFulfillment,
} from "../packages/research/fulfillment";
import { digest } from "../packages/research/direction";
import { prompt } from "../packages/prompts";
const [detailPath, out] = process.argv.slice(2);
if (!detailPath || !out)
	throw Error("Usage: research-fulfillment.ts detail.json NEW_DIR");
mkdirSync(out, { recursive: false });
const input = fulfillmentInput(await Bun.file(detailPath).json());
const text = JSON.stringify(input);
const invocation = prompt("research_fulfillment", text);
writeFileSync(
	join(out, "manifest.json"),
	JSON.stringify(
		{
			detailPath,
			inputHash: digest(input),
			promptHash: digest({
				system: invocation.system,
				content: invocation.content.text,
			}),
			model: "gpt-5.6-luna",
			reasoning: "low",
			webSearch: false,
			tokenCeiling: 200000,
			requestCeiling: 1,
			scope: "Independent factual coverage audit; not a reuse-quality score",
		},
		null,
		2,
	),
);
writeFileSync(join(out, "input.json"), JSON.stringify(input, null, 2));
if (
	Buffer.byteLength(invocation.system + invocation.content.text) + 20000 >
	200000
)
	throw Error("FULFILLMENT_INPUT_BUDGET");
try {
	const response = await new CodexLlm().complete(
		"research_fulfillment",
		text,
		AbortSignal.timeout(180000),
	);
	writeFileSync(join(out, "call.json"), JSON.stringify(response, null, 2));
	const audit = validateFulfillment(JSON.parse(response.text), input);
	writeFileSync(
		join(out, "result.json"),
		JSON.stringify({ ...audit, tokens: response.usage }, null, 2),
	);
	console.info(JSON.stringify(audit));
} catch (error) {
	writeFileSync(
		join(out, "failure.json"),
		JSON.stringify({ error: String(error) }),
	);
	throw error;
}
