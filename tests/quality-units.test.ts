import { expect, test } from "vitest";
import {
	assessStructure,
	reviewPass,
	reviewScore,
	reviewSchema,
} from "../packages/artifact/quality";
import { escapeHtml, narrativeHtml } from "../packages/artifact/narrative";
import { makeArtifact, makeDetail } from "./helpers/fixtures";

test("structural assessment flags missing sources, sections and bad references", () => {
	const unavailable = makeArtifact({
		claimIds: [],
		sections: undefined,
		body: "十分な根拠を取得できませんでした。",
		evidenceUnavailable: true,
		limitations: ["根拠なし"],
		openQuestions: [],
	});
	const missing = assessStructure(
		makeDetail({ claims: [], evidence: [], sources: [] }),
		unavailable,
	);
	expect(missing.pass).toBe(false);
	expect(missing.issues.join()).toContain("根拠");
	expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
	expect(narrativeHtml(makeArtifact())).toContain("この調査の限界");
	expect(
		narrativeHtml(makeArtifact({ limitations: [], openQuestions: [] })),
	).not.toContain("残された問い");
	const review = reviewSchema.parse({
		researchNeeded: false,
		scores: {
			scope: 5,
			support: 5,
			depth: 5,
			narrative: 5,
			readability: 5,
			knowledge: 5,
			episode: 5,
		},
		majorIssues: [],
		improvements: [],
		verdict: "pass",
	});
	expect(reviewScore(review)).toBe(100);
	expect(reviewPass(true, review)).toBe(true);
	expect(reviewPass(false, review)).toBe(false);
	expect(
		reviewPass(true, {
			...review,
			verdict: "revise",
		}),
	).toBe(false);
});
