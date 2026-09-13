/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DeliverableMemory } from "../apps/web/src/deliverable-memory";
import { makeDetail, makeMemory } from "./helpers/fixtures";
afterEach(cleanup);
test("Skill keeps fixed sections even when empty and evidence is deduplicated", () => {
	const memory = makeMemory();
	memory.knowledge[0].skill = {
		name: "verify",
		description: "原文を検証する",
		inputs: [],
		outputs: [],
		prerequisites: [],
		failureHandling: [],
	};
	memory.evidence.push({ ...memory.evidence[0] });
	render(<DeliverableMemory detail={makeDetail({ memory: [memory] })} />);
	const card = within(
		screen.getByRole("article", { name: memory.knowledge[0].title }),
	);
	for (const name of [
		"適用条件",
		"適用しない条件",
		"入力",
		"出力",
		"前提",
		"手順",
		"完了確認",
		"失敗時の対応",
	])
		expect(card.getByRole("heading", { name })).toBeTruthy();
	expect(
		card.getByRole("link", { name: /SKILL.md/ }).getAttribute("href"),
	).toContain("skills/k%3Arule");
	const summary = card.getByText("根拠").closest("summary");
	expect(summary?.textContent).toContain("参照資料 1件");
	expect(summary?.parentElement?.hasAttribute("open")).toBe(false);
});
test("Episode exposes outcomes and lessons with closed, counted failure and evidence sections", () => {
	const memory = makeMemory();
	memory.episodes[0].failedApproach = ["二次資料だけでは確認できなかった"];
	memory.episodes[0].openLoops = ["原文を追加確認する"];
	render(<DeliverableMemory detail={makeDetail({ memory: [memory] })} />);
	const card = within(
		screen.getByRole("article", { name: memory.episodes[0].title }),
	);
	expect(card.getByRole("heading", { name: "結果" })).toBeTruthy();
	expect(card.getByRole("heading", { name: "学び" })).toBeTruthy();
	for (const label of ["うまくいかなかったこと", "未解決の課題", "根拠"]) {
		const disclosure = card.getByText(label).closest("details");
		expect(disclosure?.hasAttribute("open")).toBe(false);
		expect(disclosure?.querySelector("summary")?.textContent).toContain("1件");
	}
});
