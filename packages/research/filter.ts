import type { JobDetail } from "../contracts";
import type { LlmProvider } from "../llm-provider";
import { parseScope, researchBrief } from "./scope";

/** Legacy accepted claims predate scope checks: recheck before rebuilding a report. */
export async function filterResearchClaims(
	detail: JobDetail,
	llm: LlmProvider,
	signal: AbortSignal,
) {
	const claims = detail.claims.filter((c) => c.accepted);
	const audits = [];
	const allowed = new Set<string>();
	for (let offset = 0; offset < claims.length; offset += 12) {
		const items = claims.slice(offset, offset + 12).map((c) => ({
			id: c.id,
			text: `${c.text}\nEvidence: ${c.evidenceIds.map((id) => detail.evidence.find((e) => e.id === id)?.quote || "").join("\n")}`,
		}));
		const result = await llm.complete(
			"scope",
			JSON.stringify({
				researchBrief: researchBrief(detail.job),
				stage: "claim",
				items,
			}),
			signal,
		);
		const decisions = parseScope(result.text, items);
		audits.push({ ...result, decisions });
		for (const d of decisions) if (d.status === "in_scope") allowed.add(d.id);
	}
	if (!allowed.size) throw new Error("NO_IN_SCOPE_CLAIMS");
	return {
		detail: {
			...detail,
			claims: detail.claims.map((c) => ({
				...c,
				accepted: c.accepted && allowed.has(c.id),
			})),
		},
		audits,
	};
}
