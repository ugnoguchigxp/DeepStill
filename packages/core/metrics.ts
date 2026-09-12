import type { JobDetail } from "../contracts";
export function metrics(d: JobDetail) {
	const total = d.claims.length;
	const novel = d.claims.filter((c) => c.kind === "NEW").length;
	const duplicate = d.claims.filter((c) => c.kind === "DUPLICATE").length;
	const candidates = d.candidates.filter((c) => c.type === "knowledge");
	const decided = candidates.filter((c) => c.adoption !== "pending");
	const accepted = decided.filter((c) => c.adoption === "accepted").length;
	return {
		fixture: d.job.mode === "mock",
		novelFindingRate: total ? novel / total : null,
		duplicateRate: total ? duplicate / total : null,
		knowledgeAdoptionRate: decided.length ? accepted / decided.length : null,
		adoptionDecisionCoverage: candidates.length
			? decided.length / candidates.length
			: null,
		tokenEfficiency:
			decided.length && d.job.usage.tokens
				? (accepted / d.job.usage.tokens) * 100000
				: null,
		searchEfficiency: d.job.usage.requests
			? novel / d.job.usage.requests
			: null,
		requestDenominator: "all_external_requests",
		acceptedClaims: d.claims.filter((c) => c.accepted).length,
		sourceCount: d.sources.length,
		requests: d.job.usage.requests,
		tokens: d.job.usage.tokens,
		costUsd: d.job.usage.costUsd,
	};
}
