import { z } from "zod";
export const purposeSchema = z.enum(["core", "supplement", "trivia"]);
export const briefSchema = z.object({
	requirements: z
		.array(
			z.object({
				id: z.string().min(1),
				text: z.string().min(1),
				required: z.boolean(),
				origin: z.string().min(1),
				criterion: z.string().min(1),
			}),
		)
		.min(1)
		.max(12),
});
export type Brief = z.infer<typeof briefSchema>;
export const selectionSchema = z.object({
	decisions: z
		.array(
			z.object({
				id: z.string(),
				selected: z.boolean(),
				reason: z.string().min(1),
				priority: z.number().int().min(0).max(100),
			}),
		)
		.max(24),
});
export const opportunitySchema = z.object({
	id: z.string().min(1),
	question: z.string().min(1).max(400),
	query: z.string().min(1).max(400),
	purpose: purposeSchema,
	requirementId: z.string(),
	reason: z.string().min(1),
	claimIds: z.array(z.string()),
	inScope: z.boolean(),
	value: z.number().int().min(0).max(2),
	novelty: z.number().int().min(0).max(2),
	verifiability: z.number().int().min(0).max(2),
	priority: z.number().int().min(0).max(100),
});
export type Opportunity = z.infer<typeof opportunitySchema>;
export const evaluationSchema = z.object({
	coverage: z
		.array(
			z.object({
				requirementId: z.string(),
				status: z.enum(["sufficient", "partial", "missing"]),
				reason: z.string().min(1),
				claimIds: z.array(z.string()),
			}),
		)
		.max(12),
	sufficient: z.boolean(),
	materialGaps: z.array(z.string()).max(12),
	contradictions: z.array(z.string()).max(12),
	answerOutline: z
		.array(z.object({ text: z.string(), claimIds: z.array(z.string()) }))
		.max(12),
	opportunities: z.array(opportunitySchema).max(12),
	recommendation: z.enum(["fill_gap", "enrich", "finalize"]),
	reason: z.string().min(1),
});
export type Evaluation = z.infer<typeof evaluationSchema>;
export interface Round {
	id: string;
	number: number;
	purpose: z.infer<typeof purposeSchema>;
	state:
		| "searching"
		| "selecting"
		| "reading"
		| "evaluating"
		| "evaluated"
		| "interrupted"
		| "blocked";
	queries: string[];
	selected: string[];
	candidates: {
		id: string;
		url: string;
		title: string;
		snippet: string;
		rank: number;
	}[];
	evaluation?: Evaluation;
	reason: string;
	revision: number;
	createdAt: number;
}
export interface WorkItem {
	id: string;
	jobId: string;
	roundId: string;
	kind: string;
	status:
		| "pending"
		| "running"
		| "succeeded"
		| "failed"
		| "skipped"
		| "cancelled";
	priority: number;
	reason: string;
	revision: number;
	nextAt: number;
	dependsOn: string[];
	payload: Record<string, unknown>;
	result?: unknown;
	error?: string;
	createdAt: number;
}
export interface ResearchState {
	holds?: import("./budget").BudgetHold[];
	version: 2;
	revision: number;
	rounds: Round[];
	items: WorkItem[];
	sufficient: boolean | null;
	reason: string;
	candidates: {
		id: string;
		question: string;
		purpose: z.infer<typeof purposeSchema>;
		status: string;
		revision: number;
	}[];
	slot?: { state: string; jobId: string | null; operationKey: string | null };
}
export function exactIds(expected: string[], actual: string[]) {
	if (
		new Set(actual).size !== actual.length ||
		expected.length !== actual.length ||
		expected.some((id) => !actual.includes(id))
	)
		throw new Error("INVALID_ID_COVERAGE");
}
export function validateEvaluation(
	value: unknown,
	brief: Brief,
	claimIds: string[],
): Evaluation {
	const e = evaluationSchema.parse(value);
	exactIds(
		brief.requirements.map((r) => r.id),
		e.coverage.map((c) => c.requirementId),
	);
	const refs = [
		...e.coverage.flatMap((c) => c.claimIds),
		...e.answerOutline.flatMap((c) => c.claimIds),
		...e.opportunities.flatMap((c) => c.claimIds),
	];
	if (refs.some((id) => !claimIds.includes(id)))
		throw new Error("INVALID_CLAIM_REFERENCE");
	if (e.coverage.some((c) => c.status === "sufficient" && !c.claimIds.length))
		throw new Error("UNSUPPORTED_COVERAGE");
	if (
		e.sufficient &&
		(e.materialGaps.length ||
			e.contradictions.length ||
			brief.requirements.some(
				(r) =>
					r.required &&
					e.coverage.find((c) => c.requirementId === r.id)?.status !==
						"sufficient",
			))
	)
		throw new Error("INVALID_SUFFICIENCY");
	if (new Set(e.opportunities.map((o) => o.id)).size !== e.opportunities.length)
		throw new Error("DUPLICATE_OPPORTUNITY");
	if (
		e.opportunities.some(
			(o) =>
				o.requirementId &&
				!brief.requirements.some((r) => r.id === o.requirementId),
		)
	)
		throw new Error("INVALID_REQUIREMENT_REFERENCE");
	return e;
}
export function valuable(o: Opportunity) {
	return (
		o.inScope &&
		Math.min(o.value, o.novelty, o.verifiability) >= 1 &&
		o.value + o.novelty + o.verifiability >= 5
	);
}
/** Catch keyword reordering and cosmetic additions; semantic review handles meaning. */
export function repeatedQuery(a: string, b: string) {
	const normalize = (s: string) =>
		s
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	const x = normalize(a),
		y = normalize(b);
	if (x === y) return true;
	const left = new Set(x.split(" ")),
		right = new Set(y.split(" "));
	if (Math.min(left.size, right.size) < 4) return false;
	const common = [...left].filter((w) => right.has(w)).length;
	return common / (left.size + right.size - common) >= 0.8;
}
export function chooseOpportunities(
	e: Evaluation,
	history: string[],
	remaining: number,
	canAfford: boolean,
) {
	if (remaining <= 0 || !canAfford) return [];
	const normalized = (s: string) =>
		s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	const seen = new Set(history.map(normalized));
	const candidates = e.opportunities
		.filter(
			(o) =>
				valuable(o) &&
				(e.sufficient || o.purpose === "core") &&
				![...seen].some((q) => repeatedQuery(q, o.query)),
		)
		.sort(
			(a, b) =>
				Number(!e.sufficient && b.purpose === "core") -
					Number(!e.sufficient && a.purpose === "core") ||
				b.priority - a.priority ||
				a.id.localeCompare(b.id),
		);
	const out: Opportunity[] = [];
	for (const o of candidates) {
		if (
			!e.sufficient &&
			candidates[0]?.purpose === "core" &&
			o.purpose !== "core"
		)
			continue;
		if ([...seen].some((q) => repeatedQuery(q, o.query))) continue;
		out.push(o);
		seen.add(normalized(o.query));
		if (out.length >= (remaining >= 2 ? 2 : 1)) break;
	}
	return out;
}

export const summariesSchema = z.object({
	summaries: z
		.array(
			z.object({
				id: z.string(),
				text: z.string().min(1).max(240),
				qualifications: z.string().max(100),
			}),
		)
		.max(8),
});
