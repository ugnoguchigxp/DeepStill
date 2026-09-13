import { expect, test } from "vitest";
import { researchProgress } from "../apps/web/src/research-progress";
import { researchReason } from "../apps/web/src/round-progress";
import { makeDetail, makeJob } from "./helpers/fixtures";

test("researchProgress is idle for terminal jobs", () => {
	expect(
		researchProgress(makeDetail({ job: makeJob({ status: "completed" }) })),
	).toBeNull();
});

test("researchProgress labels queued, cancel, synthesis, llm, crawl, poll and submit", () => {
	const base = makeDetail({
		job: makeJob({ status: "queued" }),
		research: undefined,
	});
	expect(researchProgress(base)?.queued).toBe(true);
	expect(researchProgress(base)?.label).toContain("Worker");
	const cancel = makeDetail({
		job: makeJob({ status: "cancel_requested" }),
		research: undefined,
		operations: [{ id: "suggest", state: "intent", startedAt: 1 }],
	});
	expect(researchProgress(cancel)?.label).toContain("停止");
	const running = makeDetail({
		job: makeJob({ status: "running" }),
		research: undefined,
	});
	expect(researchProgress(running)?.label).toContain("次の探索");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "suggest", state: "intent" }],
			}),
		)?.label,
	).toContain("検索語");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "synthesis:1", state: "intent" }],
			}),
		)?.label,
	).toContain("レポート");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "llm:src-1", state: "intent" }],
			}),
		)?.subject,
	).toBe("Research fixture");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "crawl:https://example.org:1", state: "intent" }],
			}),
		)?.subject,
	).toBe("https://example.org");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "poll:q1", state: "intent" }],
			}),
		)?.label,
	).toContain("結果を待って");
	expect(
		researchProgress(
			makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [{ id: "submit:q1", state: "intent" }],
			}),
		)?.label,
	).toContain("検索を依頼");
});

test("researchReason maps every known stop reason and keeps unknown text", () => {
	expect(researchReason("no_valuable_candidate")).toContain("候補");
	expect(researchReason("round_budget")).toContain("ラウンド");
	expect(researchReason("budget_exhausted")).toContain("探索予算");
	expect(researchReason("exploration_time_budget")).toContain("探索時間");
	expect(researchReason("generation_budget_exhausted")).toContain("回答作成");
	expect(researchReason("time_budget")).toContain("時間の上限");
	expect(researchReason("external_result_unknown")).toContain("外部処理");
	expect(researchReason("no_verified_claims")).toContain("根拠");
	expect(researchReason("custom-reason")).toBe("custom-reason");
});
