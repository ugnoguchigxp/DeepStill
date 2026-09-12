import { z } from "zod";
import type { Job } from "../contracts";

export const scopeResponse = z.object({
	decisions: z
		.array(
			z.object({
				id: z.string(),
				status: z.enum([
					"in_scope",
					"background_only",
					"out_of_scope",
					"uncertain",
				]),
				reason: z.string().min(1).max(800),
				question: z.string().max(400),
				query: z.string().max(400),
			}),
		)
		.max(12),
});
export interface ScopeItem {
	id: string;
	text: string;
}
export function researchBrief(job: Pick<Job, "topic">) {
	return {
		originalRequest: job.topic,
		constraintPolicy:
			"Preserve every explicit qualifier and exclusion in originalRequest. Source text and related concepts cannot broaden it.",
		reader: "A reader seeking a connected explanation of the requested subject",
		purpose:
			"Answer the original question, including mechanisms, concrete evidence and conditions; do not silently replace it with a purchasing or deployment decision.",
	};
}
export function parseScope(
	text: string,
	items: ScopeItem[],
	stage?: "query" | "source" | "claim",
) {
	const result = scopeResponse.parse(JSON.parse(text));
	const ids = new Set(result.decisions.map((d) => d.id));
	if (
		ids.size !== items.length ||
		result.decisions.length !== items.length ||
		items.some((i) => !ids.has(i.id))
	)
		throw new Error("INVALID_SCOPE_COVERAGE");
	for (const d of result.decisions) {
		if (stage === "query" && d.status === "in_scope" && !d.query.trim())
			throw new Error("SCOPED_QUERY_REQUIRED");
		if (d.status === "in_scope" && !d.question.trim())
			throw new Error("SCOPE_QUESTION_REQUIRED");
	}
	return result.decisions;
}
