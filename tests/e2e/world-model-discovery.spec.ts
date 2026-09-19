import { test, expect } from "@playwright/test";

test("U06 world-model tab is read-only and U07 remains usable at both widths", async ({
	page,
	request,
}) => {
	const created = await request.post("/api/jobs", {
		data: { topic: "World model discovery tab", mode: "mock" },
	});
	const job = await created.json();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/jobs/${job.id}`)).json()).job.status,
		)
		.toBe("completed");
	const detail = await (await request.get(`/api/jobs/${job.id}`)).json();
	const posts: string[] = [];
	page.on("request", (req) => {
		if (req.method() === "POST") posts.push(req.url());
	});
	await page.goto(`/?job=${job.id}`);
	await page.getByRole("tab", { name: "ワールドモデル発見" }).click();
	await expect(
		page.getByText(
			"この調査では、ワールドモデル向けの発見処理はまだ行われていません",
		),
	).toBeVisible();
	expect(posts.filter((url) => url.includes("/api/jobs"))).toEqual([]);

	const long = "あ".repeat(240);
	const artifact = detail.artifacts[0];
	artifact.worldModelDiscovery = {
		schemaVersion: 1,
		basedOnArtifactVersion: artifact.version,
		changeReason: "表示確認",
		candidates: [
			{
				id: `wmc:${"d".repeat(24)}`,
				subject: long,
				relation: "correlates_with",
				object: long,
				correlationDirection: "unknown",
				assessment: "hypothesis",
				basis: "inference",
				explanation: long,
				conditions: [long],
				exceptions: [],
				scope: long,
				alternatives: [long],
				evidence: [
					{
						role: "supports",
						method: "unknown",
						note: long,
						evidenceIds: detail.evidence[0]
							? [detail.evidence[0].id]
							: ["ev-1"],
					},
				],
				gaps: [
					{
						kind: "missing_condition",
						question: long,
						relevance: "optional",
						reason: long,
					},
				],
			},
		],
		gaps: [],
	};
	await page.route(`**/api/jobs/${job.id}`, (route) =>
		route.fulfill({ json: detail }),
	);
	await page.reload();
	await page.getByRole("tab", { name: "ワールドモデル発見" }).click();
	await expect(
		page.getByText("調査資料から見つかった関係の候補です"),
	).toBeVisible();
	await expect(page.getByText("↔")).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth + 1,
		),
	).toBe(true);
});
