import { expect, test } from "vitest";
import {
	actionKey,
	applyCoverage,
	initialQuestions,
	pendingSourceBatch,
	sourceAttempts,
	validateAction,
	type ActionCandidate,
} from "../packages/research/direction";
import {
	makeDetail,
	makeJob,
	makeResearch,
	makeWorkItem,
} from "./helpers/fixtures";

const brief = {
	requirements: [
		{
			id: "main",
			text: "Explain",
			required: true,
			origin: "user",
			criterion: "Evidence",
		},
	],
};

const action = (over: Partial<ActionCandidate> = {}): ActionCandidate => ({
	id: "a1",
	purpose: "required",
	operation: "search",
	questionIds: ["main"],
	gapIds: [],
	expectedDelta: "new evidence",
	reason: "gap",
	inScope: true,
	novel: true,
	targetId: "",
	start: 0,
	end: 0,
	dependsOn: [],
	estimatedTokens: 10,
	estimatedRequests: 1,
	...over,
});

test("initialQuestions, applyCoverage and action validation cover remaining branches", () => {
	const questions = initialQuestions(brief, 1);
	expect(questions[0].origin).toBe("user");
	const inferred = initialQuestions(
		{
			requirements: [
				{
					id: "x",
					text: "Inferred",
					required: false,
					origin: "inferred",
					criterion: "c",
				},
			],
		},
		2,
	);
	expect(inferred[0].origin).toBe("inferred");
	const covered = applyCoverage(
		questions,
		{
			coverage: [
				{
					requirementId: "main",
					status: "sufficient",
					reason: "ok",
					claimIds: ["c1"],
				},
			],
			sufficient: true,
			materialGaps: [],
			contradictions: [],
			answerOutline: [],
			opportunities: [],
			recommendation: "finalize",
			reason: "ok",
		},
		3,
	);
	expect(covered[0].status).toBe("supported");
	expect(
		applyCoverage(
			questions,
			{
				coverage: [],
				sufficient: false,
				materialGaps: [],
				contradictions: [],
				answerOutline: [],
				opportunities: [],
				recommendation: "fill_gap",
				reason: "x",
			},
			3,
		)[0].status,
	).toBe("open");
	expect(
		validateAction(
			action({ inScope: false }),
			"q",
			makeDetail(),
			questions,
			[],
		),
	).toBe("no_information_delta");
	expect(
		validateAction(
			action({ questionIds: ["missing"] }),
			"q",
			makeDetail(),
			questions,
			[],
		),
	).toBe("unknown_question");
	expect(
		validateAction(
			action({ dependsOn: ["nope"] }),
			"q",
			makeDetail(),
			questions,
			[],
		),
	).toBe("dependency_unmet");
	expect(
		validateAction(
			action({ purpose: "supplement" }),
			"q",
			makeDetail(),
			questions,
			[],
		),
	).toBe("core_unmet");
	const key = actionKey(action(), "Query One");
	expect(
		validateAction(action(), "Query One", makeDetail(), questions, [
			{ key, status: "succeeded" },
		]),
	).toBe("duplicate_action");
	expect(
		validateAction(action(), "evidence snapshots", makeDetail(), questions, []),
	).toBe("duplicate_query");
	expect(
		validateAction(
			action({ operation: "search" }),
			"  ",
			makeDetail(),
			questions,
			[],
		),
	).toBe("duplicate_query");
	expect(
		validateAction(
			action({ operation: "read_source", targetId: "missing", end: 4 }),
			"",
			makeDetail(),
			questions,
			[],
		),
	).toBe("invalid_source_range");
	const detail = makeDetail({
		research: makeResearch({
			items: [
				makeWorkItem({
					kind: "read",
					status: "succeeded",
					payload: { sourceId: "src-1", start: 0, end: 10 },
				}),
			],
		}),
	});
	expect(
		validateAction(
			action({
				operation: "read_source",
				targetId: "src-1",
				start: 0,
				end: 10,
			}),
			"",
			detail,
			questions,
			[],
		),
	).toBe("duplicate_range");
	expect(
		validateAction(
			action({
				operation: "read_source",
				targetId: "src-1",
				start: 0,
				end: 20,
			}),
			"",
			makeDetail(),
			questions,
			[],
		),
	).toBeNull();
	expect(
		pendingSourceBatch([makeWorkItem({ kind: "fetch", status: "pending" })]),
	).toBe(true);
	expect(
		pendingSourceBatch([makeWorkItem({ kind: "evaluate", status: "pending" })]),
	).toBe(false);
	const attempts = sourceAttempts(
		makeDetail({
			job: makeJob(),
			research: makeResearch({
				items: [
					makeWorkItem({
						id: "f1",
						kind: "fetch",
						status: "failed",
						error: "guard blocked",
						result: { sourceId: null },
						payload: {
							url: "https://x",
							questionIds: ["main"],
							selectionReason: "try",
						},
					}),
					makeWorkItem({
						id: "f2",
						kind: "fetch",
						status: "succeeded",
						result: { sourceId: "src-1" },
						payload: { url: "https://y" },
					}),
					makeWorkItem({
						id: "r1",
						kind: "read",
						status: "succeeded",
						payload: { fetchId: "f2" },
					}),
					makeWorkItem({
						id: "c1",
						kind: "check_claims",
						status: "succeeded",
						payload: { readId: "r1" },
					}),
				],
			}),
		}),
	);
	expect(attempts.find((a) => a.workId === "f1")?.state).toBe(
		"approval_pending",
	);
	expect(attempts.find((a) => a.workId === "f2")?.state).toBe("read");
});
