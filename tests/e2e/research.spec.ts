import { test, expect } from "@playwright/test";
test("research completes and citation opens the immutable evidence", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByLabel("調べたいテーマ").fill("Evidence-first research");
	await page.getByLabel("実行モード", { exact: true }).selectOption("mock");
	await page.getByRole("button", { name: "固定サンプルで動作確認" }).click();
	await expect(page.getByText("完了", { exact: true }).first()).toBeVisible({
		timeout: 30000,
	});
	await page.getByRole("button", { name: "[1] 根拠を確認" }).click();
	await expect(
		page.getByRole("dialog", { name: "Evidence詳細" }),
	).toBeVisible();
	await expect(page.getByText("引用位置（UTF-16）")).toBeVisible();
	await expect(page.getByRole("button", { name: "閉じる ×" })).toHaveCount(0);
	await page.getByRole("dialog").getByRole("heading", { level: 2 }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByLabel("調べたいテーマ").focus();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByLabel("調べたいテーマ")).toBeFocused();
	await page.getByRole("button", { name: "[1] 根拠を確認" }).click();
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "[1] 根拠を確認" }).click();
	await page.locator(".drawer-backdrop").click({ position: { x: 5, y: 5 } });
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "[1] 根拠を確認" }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Research Artifact" }),
	).toBeVisible();
	await page.getByRole("tab", { name: "Knowledge・Episode" }).click();
	await expect(
		page.getByRole("heading", { name: "再利用する知識と記憶" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Memory JSONを開く ↗" }),
	).toBeVisible();
	await page.getByRole("tab", { name: "探索経路" }).click();
	await expect(
		page.getByRole("heading", { name: "Query Frontier" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
});
test("invalid input and cross-origin mutation are rejected", async ({
	request,
}) => {
	expect(
		(await request.post("/api/jobs", { data: { topic: "x" } })).status(),
	).toBe(400);
	expect(
		(
			await request.post("/api/jobs", {
				headers: { Origin: "https://evil.example" },
				data: { topic: "malicious origin" },
			})
		).status(),
	).toBe(403);
});

test("cancelled job survives reload", async ({ page, request }) => {
	const response = await request.post("/api/jobs", {
		data: { topic: "cancelled research" },
	});
	const job = await response.json();
	await request.post(`/api/jobs/${job.id}/cancel`, { data: {} });
	await page.goto(`/?job=${job.id}`);
	await expect(page.getByText("停止済み", { exact: true }).first()).toBeVisible(
		{ timeout: 10000 },
	);
	await page.reload();
	await expect(
		page.getByText("停止済み", { exact: true }).first(),
	).toBeVisible();
});

test("structured report renders findings, inference and limitations with working citations", async ({
	page,
	request,
}) => {
	const created = await request.post("/api/jobs", {
		data: { topic: "Structured report rendering" },
	});
	const job = await created.json();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/jobs/${job.id}`)).json()).job.status,
		)
		.toBe("completed");
	const detail = await (await request.get(`/api/jobs/${job.id}`)).json();
	const artifact = detail.artifacts[0];
	const claimId = artifact.claimIds[0];
	artifact.sections = [
		{
			title: "資料間の比較",
			paragraphs: [
				{
					text: "<script>window.reportInjected=true</script> 原文と考察を区別する。",
					kind: "inference",
					claimIds: [claimId],
				},
			],
		},
	];
	artifact.limitations = ["この資料だけでは因果関係は判断できない。"];
	artifact.openQuestions = ["別の宗派でも同じ結果になるか。"];
	await page.route(`**/api/jobs/${job.id}`, (route) =>
		route.fulfill({ json: detail }),
	);
	await page.goto(`/?job=${job.id}`);
	await expect(
		page.getByRole("heading", { name: "1. 資料間の比較" }),
	).toBeVisible();
	await expect(
		page.getByText("この資料だけでは因果関係は判断できない。"),
	).toBeVisible();
	expect(
		await page.evaluate(() => Object.hasOwn(window, "reportInjected")),
	).toBe(false);
	await page.getByRole("button", { name: "[1] 根拠を確認" }).click();
	await expect(
		page.getByRole("dialog", { name: "Evidence詳細" }),
	).toBeVisible();
});

test("live is default and persisted operations show loading until completion", async ({
	page,
	request,
}) => {
	const created = await request.post("/api/jobs", {
		data: {
			topic: "Progress rendering fixture",
			mode: "mock",
			engineVersion: 1,
		},
	});
	const job = await created.json();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/jobs/${job.id}`)).json()).job.status,
		)
		.toBe("completed");
	const detail = await (await request.get(`/api/jobs/${job.id}`)).json();
	await page.route("**/api/config", (route) =>
		route.fulfill({
			json: {
				liveReady: true,
				llmProvider: "codex",
				model: "gpt-5.6-luna",
				reasoning: "low",
				searchProvider: "codex",
			},
		}),
	);
	await page.goto("/");
	await expect(page.getByLabel("実行モード", { exact: true })).toHaveValue(
		"live",
	);
	detail.job.status = "running";
	detail.job.mode = "live";
	detail.job.updatedAt = Date.now();
	detail.operations = [
		{ id: "suggest", state: "intent", startedAt: Date.now() },
	];
	await page.route(`**/api/jobs/${job.id}`, (route) =>
		route.fulfill({ json: detail }),
	);
	await page.goto(`/?job=${job.id}`);
	const progress = page.getByRole("region", { name: "調査の進行状況" });
	await expect(progress).toContainText(
		"LLMが探索する論点と検索語を考えています",
	);
	await expect(progress.locator(".loading-spinner")).toBeVisible();
	await page.reload();
	await expect(progress.locator(".loading-spinner")).toBeVisible();
	for (const [id, label] of [
		["poll:query:0", "Web検索の結果を待っています"],
		["crawl:https://example.org:0", "Webページの本文を取得しています"],
		["llm:source", "LLMが取得した資料を読み、根拠を抽出しています"],
		["synthesis:0", "LLMが根拠を整理し、レポートを作成しています"],
	]) {
		detail.operations = [{ id, state: "intent", startedAt: Date.now() }];
		await page.reload();
		await expect(progress).toContainText(label);
	}
	detail.job.status = "completed";
	await page.reload();
	await expect(progress).toHaveCount(0);
	detail.job.mode = "mock";
	await page.reload();
	await expect(
		page.getByText("これは固定サンプルによる動作確認です。"),
	).toBeVisible();
	await page.route("**/api/jobs", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		expect(route.request().postDataJSON()).toMatchObject({
			topic: job.topic,
			mode: "live",
		});
		await route.fulfill({ json: { ...job, id: job.id, mode: "live" } });
	});
	await page.getByRole("button", { name: "このテーマでWeb調査を開始" }).click();
});

test("stopped research resumes from the UI and survives reload", async ({
	page,
	request,
}) => {
	const response = await request.post("/api/jobs", {
		data: { topic: "Resume from controls", mode: "mock" },
	});
	const job = await response.json();
	await request.post(`/api/jobs/${job.id}/cancel`, { data: {} });
	await page.goto(`/?job=${job.id}`);
	await expect(page.getByRole("button", { name: "探索を再開" })).toBeVisible();
	await page.getByRole("button", { name: "探索を再開" }).click();
	await expect(page.getByText("完了", { exact: true }).first()).toBeVisible({
		timeout: 30000,
	});
	await page.reload();
	await expect(page.getByRole("button", { name: "探索を再開" })).toHaveCount(0);
	expect(
		(await (await request.get(`/api/jobs/${job.id}`)).json()).events.some(
			(e: { type: string }) => e.type === "job.resumed",
		),
	).toBe(true);
});

test("missing worker disables real start instead of silently creating a demo", async ({
	page,
}) => {
	await page.route("**/api/config", (route) =>
		route.fulfill({
			json: {
				liveReady: false,
				worker: { ready: false, stale: false },
				llmProvider: "codex",
				model: "gpt-5.6-luna",
				reasoning: "low",
				searchProvider: "codex",
			},
		}),
	);
	await page.goto("/");
	await page.getByLabel("調べたいテーマ").fill("Real research");
	await expect(
		page.getByRole("button", { name: "調査をはじめる", exact: true }),
	).toBeDisabled();
	await expect(page.getByLabel("実行モード", { exact: true })).toHaveValue(
		"live",
	);
});

test("research deletion requires confirmation and clears the selected report", async ({
	page,
	request,
}, testInfo) => {
	test.skip(
		testInfo.project.name === "mobile",
		"Recent Research sidebar is desktop-only",
	);
	const topic = "Delete research with confirmation";
	const job = await (
		await request.post("/api/jobs", { data: { topic, mode: "mock" } })
	).json();
	await page.goto(`/?job=${job.id}`);
	const remove = page.getByRole("button", {
		name: `${topic}を削除`,
		exact: true,
	});
	await remove.click();
	const modal = page.getByRole("dialog", {
		name: "この調査を完全に削除しますか？",
	});
	await expect(modal).toBeVisible();
	await expect(modal).toContainText("元に戻すことはできません");
	await expect(modal.getByRole("button", { name: "キャンセル" })).toBeFocused();
	await modal.getByRole("button", { name: "キャンセル" }).click();
	await expect(modal).toHaveCount(0);
	expect((await request.get(`/api/jobs/${job.id}`)).status()).toBe(200);
	await remove.click();
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
	await remove.click();
	await page.route(
		`**/api/jobs/${job.id}/delete`,
		(route) =>
			route.fulfill({ status: 500, json: { error: "INTERNAL_ERROR" } }),
		{ times: 1 },
	);
	await modal.getByRole("button", { name: "完全に削除する" }).click();
	await expect(modal.getByRole("alert")).toContainText("削除に失敗しました");
	expect((await request.get(`/api/jobs/${job.id}`)).status()).toBe(200);
	await modal.getByRole("button", { name: "完全に削除する" }).click();
	await expect(modal).toHaveCount(0);
	await expect(remove).toHaveCount(0);
	await expect(page).not.toHaveURL(/\?job=/);
	expect((await request.get(`/api/jobs/${job.id}`)).status()).toBe(404);
	await page.reload();
	await expect(remove).toHaveCount(0);
});
test("round evaluation and its evidence survive reload", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("調べたいテーマ").fill("Round evaluation sample");
	await page.getByLabel("実行モード", { exact: true }).selectOption("mock");
	await page.getByRole("button", { name: "固定サンプルで動作確認" }).click();
	const rounds = page.getByRole("region", { name: "ラウンド探索" });
	await expect(rounds.getByText("回答に必要な根拠は揃っています")).toBeVisible({
		timeout: 30000,
	});
	await rounds.getByText("評価の根拠", { exact: true }).click();
	await expect(
		rounds.getByText("十分：Fixture evidence coverage"),
	).toBeVisible();
	await page.reload();
	await expect(
		page
			.getByRole("region", { name: "ラウンド探索" })
			.getByText("回答に必要な根拠は揃っています"),
	).toBeVisible();
	await page.screenshot({
		path: `/tmp/deepstill-round-${test.info().project.name}.png`,
		fullPage: true,
	});
});
