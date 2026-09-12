import { z } from "zod";
import type { Artifact, JobDetail } from "../contracts";
import { validateArtifact } from "./index";
export function assessStructure(detail: JobDetail, artifact: Artifact) {
	validateArtifact(detail, artifact);
	const used = new Set(
		artifact.claimIds
			.flatMap(
				(id) => detail.claims.find((c) => c.id === id)?.evidenceIds || [],
			)
			.map((id) => detail.evidence.find((e) => e.id === id)?.snapshotId),
	);
	const sources = detail.sources.filter((s) => used.has(s.id));
	const domains = new Set(sources.map((s) => new URL(s.finalUrl).hostname));
	const paragraphs = artifact.sections?.flatMap((s) => s.paragraphs) || [];
	const badReferences = paragraphs
		.flatMap((p) => p.claimIds)
		.filter((id) => !artifact.claimIds.includes(id));
	const issues = [
		sources.length === 0 ? "根拠資料がない" : null,

		(artifact.sections?.length || 0) === 0 ? "本文の章がない" : null,

		badReferences.length ? "章内に不正な参照" : null,
	].filter(Boolean);
	return {
		pass: issues.length === 0,
		issues,
		sources: sources.length,
		domains: domains.size,
		claims: artifact.claimIds.length,
		sections: artifact.sections?.length || 0,
		paragraphs: paragraphs.length,
		quoteIntegrity: true,
	};
}

export const REVIEW_VERSION = "research-quality-v2";
export const reviewWeights = {
	scope: 20,
	support: 20,
	depth: 20,
	narrative: 15,
	readability: 10,
	knowledge: 10,
	episode: 5,
} as const;
export const reviewSchema = z.object({
	scores: z.object({
		scope: z.number().min(0).max(5),
		support: z.number().min(0).max(5),
		depth: z.number().min(0).max(5),
		narrative: z.number().min(0).max(5),
		readability: z.number().min(0).max(5),
		knowledge: z.number().min(0).max(5),
		episode: z.number().min(0).max(5),
	}),
	majorIssues: z.array(z.string()),
	improvements: z.array(z.string()),
	verdict: z.enum(["pass", "revise"]),
});
export function reviewScore(review: z.infer<typeof reviewSchema>) {
	return Object.entries(reviewWeights).reduce(
		(n, [key, weight]) =>
			n + (review.scores[key as keyof typeof reviewWeights] / 5) * weight,
		0,
	);
}
export function reviewPass(
	structuralPass: boolean,
	review: z.infer<typeof reviewSchema>,
) {
	return (
		structuralPass &&
		review.verdict === "pass" &&
		reviewScore(review) >= 96 &&
		Object.values(review.scores).every((score) => score >= 4.5) &&
		review.majorIssues.length === 0
	);
}
