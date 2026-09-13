import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchEvent } from "../apps/web/src/research-event";
import type { Event } from "../packages/contracts";
const render = (type: string, data: unknown) =>
	renderToStaticMarkup(
		<ResearchEvent
			event={{ id: 1, jobId: "job", createdAt: 0, type, data } as Event}
		/>,
	);
test("history distinguishes actual selection from execution and preserves source provenance", () => {
	const decision = render("research.decision", {
		actor: "llm",
		action: "fetch",
		purpose: "不足する定義を確認",
		target: "https://example.com/paper",
		trigger: "retrieval_failed",
		parentSourceId: "intro",
	});
	expect(decision).toContain("LLMによる次の行動");
	expect(decision).toContain("取得失敗");
	expect(decision).toContain("intro");
	expect(decision).toContain("不足する定義を確認");
	expect(
		render("research.decision", {
			actor: "llm",
			action: "search",
			trigger: "search_results",
		}),
	).toContain("検索結果");
	expect(
		render("research.decision", {
			actor: "llm",
			action: "read",
			trigger: "source_read",
		}),
	).toContain("本文の読解");
	const action = render("research.action", {
		action: "fetch",
		purpose: "定義",
		result: "未読",
	});
	expect(action).toContain("未読");
	expect(action).not.toContain("LLMによる");
	expect(render("research.action", {})).not.toContain("undefined");
	expect(render("operation.completed", null)).toContain("operation.completed");
	expect(render("research.decision", { actor: "program" })).not.toContain(
		"LLMによる",
	);
});
