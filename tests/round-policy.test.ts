import { expect, test } from "vitest";
import {
	type Brief,
	chooseOpportunities,
	type Evaluation,
	repeatedQuery,
	validateEvaluation,
} from "../packages/research/rounds";

const brief: Brief = {
	requirements: [
		{
			id: "main",
			text: "Explain",
			required: true,
			origin: "Explain",
			criterion: "Evidence",
		},
	],
};
const evaluation: Evaluation = {
	coverage: [
		{
			requirementId: "main",
			status: "sufficient",
			reason: "Supported",
			claimIds: ["c"],
		},
	],
	sufficient: true,
	materialGaps: [],
	contradictions: [],
	answerOutline: [],
	opportunities: [
		{
			id: "o",
			question: "Historical example",
			query: "primary historical example",
			purpose: "trivia",
			requirementId: "main",
			reason: "Explains origin",
			claimIds: ["c"],
			inScope: true,
			value: 2,
			novelty: 2,
			verifiability: 2,
			priority: 90,
		},
	],
	recommendation: "enrich",
	reason: "Adds understanding",
};
test("sufficient answers continue for valuable trivia with budget", () => {
	expect(chooseOpportunities(evaluation, [], 3, true)).toHaveLength(1);
});
test("round and resource limits independently stop expansion", () => {
	expect(chooseOpportunities(evaluation, [], 0, true)).toHaveLength(0);
	expect(chooseOpportunities(evaluation, [], 3, false)).toHaveLength(0);
});
test("duplicates and low-value tangents never fill remaining budget", () => {
	expect(
		chooseOpportunities(evaluation, ["PRIMARY historical example"], 4, true),
	).toHaveLength(0);
	expect(
		chooseOpportunities(
			{
				...evaluation,
				opportunities: [{ ...evaluation.opportunities[0], inScope: false }],
			},
			[],
			4,
			true,
		),
	).toHaveLength(0);
});
test("sufficiency cannot mask missing requirements or unsupported citations", () => {
	expect(() =>
		validateEvaluation(
			{ ...evaluation, materialGaps: ["Missing explanation"] },
			brief,
			["c"],
		),
	).toThrow("INVALID_SUFFICIENCY");
	expect(() => validateEvaluation(evaluation, brief, [])).toThrow(
		"INVALID_CLAIM_REFERENCE",
	);
	expect(() =>
		validateEvaluation({ ...evaluation, coverage: [] }, brief, ["c"]),
	).toThrow("INVALID_ID_COVERAGE");
});
import { roundCases } from "./fixtures/round-cases";
for (const c of roundCases)
	test(`fixed case ${c.id}: ${c.topic}`, () => {
		const value = {
			...evaluation,
			sufficient: c.sufficient,
			opportunities: c.valuable
				? evaluation.opportunities.map((o) => ({
						...o,
						purpose: c.sufficient ? o.purpose : ("core" as const),
					}))
				: [],
		};
		expect(chooseOpportunities(value, [], c.remaining, c.afford)).toHaveLength(
			c.expected,
		);
	});

test("missing central coverage never spends remaining rounds on optional trivia", () => {
	expect(
		chooseOpportunities({ ...evaluation, sufficient: false }, [], 4, true),
	).toHaveLength(0);
});

test("cosmetic query changes cannot restart the same exploration", () => {
	expect(
		repeatedQuery(
			"WebGPT Comparisons score_0 score_1 preference -1 1",
			"WebGPT Comparisons score_0 score_1 preference -1 1 dataset",
		),
	).toBe(true);
	expect(
		repeatedQuery(
			"query formulation retrieval result selection citations",
			"citations selection result retrieval formulation query",
		),
	).toBe(true);
	expect(
		repeatedQuery(
			"WebGPT human feedback training",
			"WebGPT citation accuracy evaluation",
		),
	).toBe(false);
});
