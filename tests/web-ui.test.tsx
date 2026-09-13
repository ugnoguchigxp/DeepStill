/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../apps/web/src/main";
import { DeleteResearchDialog } from "../apps/web/src/delete-research-dialog";
import { ResearchProgress } from "../apps/web/src/research-progress";
import {
	DeletedExecutionRecovery,
	RoundProgress,
} from "../apps/web/src/round-progress";
import {
	makeArtifact,
	makeDetail,
	makeJob,
	makeResearch,
	makeSource,
	makeWorkItem,
} from "./helpers/fixtures";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const job = makeJob({ status: "running" });
const completed = makeDetail({
	job: makeJob({ status: "completed", reason: "round_budget" }),
});
let config: Record<string, unknown> = {
	liveReady: true,
	executionBlocked: false,
	worker: { ready: true, stale: false },
	codex: { ready: true, error: null },
	contextConnected: false,
	llmProvider: "compatible",
	model: "test",
	reasoning: null,
	searchProvider: "dataforseo",
};
let jobs = [job];
let detail = makeDetail({ job });

beforeEach(() => {
	jobs = [job];
	detail = makeDetail({ job });
	config = {
		liveReady: true,
		executionBlocked: false,
		worker: { ready: true, stale: false },
		codex: { ready: true, error: null },
		contextConnected: false,
		llmProvider: "compatible",
		model: "test",
		reasoning: null,
		searchProvider: "dataforseo",
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/config")) return json(config);
			if (url.endsWith("/api/jobs") && method === "GET") return json(jobs);
			if (url.endsWith("/api/jobs") && method === "POST") {
				const body = JSON.parse(String(init?.body ?? "{}"));
				if (body.topic?.length < 2)
					return json({ error: "INVALID_INPUT" }, 400);
				const created = makeJob({
					id: "22222222-2222-4222-8222-222222222222",
					topic: body.topic,
					mode: body.mode,
					status: "queued",
				});
				jobs = [created, ...jobs];
				return json(created, 201);
			}
			if (url.includes("/delete") && method === "POST")
				return json({ deleted: true });
			if (url.includes("/resume")) return json({ ...job, status: "queued" });
			if (url.includes("/cancel"))
				return json({ ...job, status: "cancel_requested" });
			if (url.includes("/confirm-external-stopped")) return json({ ok: true });
			if (url.includes("/execution/confirm-stopped")) {
				if (JSON.parse(String(init?.body ?? "{}")).reason?.length < 5)
					return json({ error: "INVALID_INPUT" }, 400);
				return json({ ok: true });
			}
			if (url.includes("/work-items/") && method === "PATCH")
				return json({ ok: true });
			if (url.includes("/exploration-candidates"))
				return json({ ok: true }, 201);
			if (url.includes(`/api/jobs/${job.id}`) || url.includes("/api/jobs/1111"))
				return json(detail);
			return json({ error: "NOT_FOUND" }, 404);
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	history.replaceState(null, "", "/");
});

function renderApp() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<App />
		</QueryClientProvider>,
	);
}

test("empty workspace and creating a mock job", async () => {
	jobs = [];
	renderApp();
	expect(
		await screen.findByText("最初の問いから、始めましょう。"),
	).toBeTruthy();
	fireEvent.change(screen.getByLabelText("調べたいテーマ"), {
		target: { value: "KV cache" },
	});
	fireEvent.change(screen.getByLabelText("実行モード"), {
		target: { value: "mock" },
	});
	fireEvent.click(screen.getByText("予算を設定"));
	fireEvent.change(screen.getByLabelText("Query上限"), {
		target: { value: "20" },
	});
	fireEvent.change(screen.getByLabelText("時間上限（分）"), {
		target: { value: "30" },
	});
	fireEvent.change(screen.getByLabelText("探索の深さ"), {
		target: { value: "2" },
	});
	fireEvent.change(screen.getByLabelText("検索費用上限（USD）"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("探索戦略"), {
		target: { value: "diverse" },
	});
	fireEvent.click(screen.getByRole("button", { name: /固定サンプル/ }));
	await waitFor(() =>
		expect(jobs.some((item) => item.topic === "KV cache")).toBe(true),
	);
});

test("job list, tabs, evidence drawer and delete dialog", async () => {
	detail = completed;
	jobs = [completed.job];
	renderApp();
	const item = await screen.findByText("LLMとWeb探索", {
		selector: ".job-link span",
	});
	fireEvent.click(item);
	expect(await screen.findByText("Research Artifact")).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: /探索経路/ }));
	expect(screen.getByText("Query Frontier")).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: /知見と根拠/ }));
	fireEvent.click(screen.getByRole("button", { name: /Evidenceを開く/ }));
	expect(await screen.findByLabelText("Evidence詳細")).toBeTruthy();
	fireEvent.keyDown(document, { key: "Escape" });
	fireEvent.click(screen.getByRole("tab", { name: /Knowledge/ }));
	expect(screen.getByText(/再利用する知識/)).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: /実行履歴/ }));
	expect(screen.getByText("Activity log")).toBeTruthy();
	fireEvent.click(screen.getByLabelText("LLMとWeb探索を削除"));
	expect(screen.getByText("この調査を完全に削除しますか？")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	await waitFor(() =>
		expect(screen.queryByText("この調査を完全に削除しますか？")).toBeNull(),
	);
});

test("resume, cancel, worker warnings and provider labels", async () => {
	detail = makeDetail({
		job: makeJob({ status: "partial", reason: "budget_exhausted" }),
	});
	jobs = [detail.job];
	config = {
		...config,
		liveReady: false,
		llmProvider: "codex",
		model: "gpt-5.6-luna",
		reasoning: "low",
		searchProvider: "codex",
		worker: { ready: false, stale: true },
		codex: { ready: false, error: "CODEX_CLI_TOO_OLD" },
	};
	renderApp();
	fireEvent.click(
		await screen.findByText("LLMとWeb探索", { selector: ".job-link span" }),
	);
	expect(
		await screen.findByText((text) => text.includes("Workerが古いコード")),
	).toBeTruthy();
	expect(screen.getByText(/Codex CLIを利用できません/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /探索を再開/ }));
	config = {
		...config,
		worker: { ready: false, stale: false },
		codex: { ready: true, error: null },
	};
	cleanup();
	detail = makeDetail({ job: makeJob({ status: "running" }) });
	jobs = [detail.job];
	renderApp();
	fireEvent.click(
		await screen.findByText("LLMとWeb探索", { selector: ".job-link span" }),
	);
	expect(
		await screen.findByText((text) => text.includes("Workerが起動していない")),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /探索を中止/ }));
});

test("RoundProgress, ResearchProgress and recovery forms", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const wrap = (node: ReactNode) => {
		cleanup();
		return render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		);
	};
	const running = makeDetail({
		job: makeJob({ status: "running" }),
		research: makeResearch({
			sufficient: true,
			slot: {
				state: "blocked",
				jobId: job.id,
				operationKey: "pending:search",
			},
			rounds: [
				{
					id: "r1",
					number: 2,
					purpose: "trivia",
					state: "blocked",
					queries: [],
					selected: [],
					candidates: [],
					reason: "",
					revision: 1,
					createdAt: Date.now(),
					evaluation: {
						coverage: [
							{
								requirementId: "main",
								status: "sufficient",
								reason: "ok",
								claimIds: ["c1"],
							},
							{
								requirementId: "side",
								status: "missing",
								reason: "none",
								claimIds: [],
							},
						],
						sufficient: true,
						materialGaps: [],
						contradictions: [],
						answerOutline: [],
						opportunities: [],
						recommendation: "finalize",
						reason: "done",
					},
				},
			],
			items: [
				makeWorkItem({ status: "running", kind: "evaluate" }),
				makeWorkItem({
					id: "p1",
					status: "pending",
					kind: "search_submit",
					payload: { query: "more" },
				}),
			],
		}),
	});
	wrap(<RoundProgress detail={running} />);
	expect(screen.getByText(/トリビアを調査/)).toBeTruthy();
	fireEvent.click(screen.getByLabelText(/外部サービス側で処理が終了/));
	fireEvent.change(screen.getByLabelText("確認した内容"), {
		target: { value: "vendor dashboard shows done" },
	});
	fireEvent.submit(screen.getByText("終了確認を記録").closest("form")!);
	fireEvent.click(screen.getByRole("button", { name: "優先する" }));
	fireEvent.change(screen.getByLabelText(/次のラウンド/), {
		target: { value: "追加の具体例" },
	});
	fireEvent.submit(screen.getByText("候補を追加").closest("form")!);
	wrap(
		<RoundProgress
			detail={makeDetail({
				research: makeResearch({
					sufficient: null,
					rounds: [
						{
							...makeResearch().rounds[0],
							purpose: "supplement",
							evaluation: undefined,
						},
					],
					items: [],
					holds: [],
					reason: "",
					slot: { state: "idle", jobId: null, operationKey: null },
				}),
			})}
		/>,
	);
	expect(screen.getByText(/補足を調査/)).toBeTruthy();
	wrap(
		<ResearchProgress
			detail={makeDetail({
				job: makeJob({ status: "running" }),
				research: undefined,
				operations: [
					{ id: "suggest", state: "intent", startedAt: Date.now() - 40000 },
				],
			})}
		/>,
	);
	expect(screen.getByLabelText("調査の進行状況")).toBeTruthy();
	wrap(
		<ResearchProgress
			unavailable
			detail={makeDetail({
				job: makeJob({ status: "queued" }),
				research: undefined,
			})}
		/>,
	);
	expect(screen.getByText(/進捗を取得できません/)).toBeTruthy();
	wrap(<DeletedExecutionRecovery />);
	fireEvent.click(screen.getByLabelText(/外部サービス側の処理終了/));
	fireEvent.change(screen.getByLabelText("確認内容"), {
		target: { value: "stopped in vendor UI" },
	});
	fireEvent.submit(screen.getByText("終了確認を記録").closest("form")!);
	wrap(
		<DeleteResearchDialog
			topic="delete me"
			pending
			error="失敗"
			onCancel={() => {}}
			onDelete={() => {}}
		/>,
	);
	expect(screen.getByText("削除しています…")).toBeTruthy();
	expect(screen.getByRole("alert").textContent).toContain("失敗");
});

test("create failure and execution blocked banner", async () => {
	config = { ...config, executionBlocked: true, liveReady: false };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/config")) return json(config);
			if (url.endsWith("/api/jobs") && (init?.method ?? "GET") === "GET")
				return json([]);
			if (url.endsWith("/api/jobs"))
				return json({ error: "LIVE_NOT_READY" }, 503);
			return json({ error: "x" }, 500);
		}),
	);
	renderApp();
	expect(await screen.findByLabelText("削除済み調査の処理確認")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("実行モード"), {
		target: { value: "mock" },
	});
	fireEvent.change(screen.getByLabelText("調べたいテーマ"), {
		target: { value: "failing topic" },
	});
	fireEvent.click(screen.getByRole("button", { name: /固定サンプル/ }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toMatch(
			/LIVE_NOT_READY|通信/,
		),
	);
});

test("remaining job views: load error, mock restart, empty artifact, revision, truncated evidence", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/config")) return json(config);
			if (url.endsWith("/api/jobs")) return json({ error: "down" }, 500);
			return json({ error: "x" }, 500);
		}),
	);
	renderApp();
	expect(
		await screen.findByText(
			"データの取得に失敗しました。APIの起動を確認してください。",
		),
	).toBeTruthy();
	cleanup();
	config = {
		...config,
		liveReady: true,
		worker: { ready: true, stale: false },
	};
	detail = makeDetail({
		job: makeJob({
			status: "partial",
			mode: "mock",
		}),
		artifacts: [],
		memory: [],
		claims: [],
		research: undefined,
		qualityReviews: [
			{
				version: 1,
				review: { verdict: "revise", scores: { scope: 1 } },
			},
		],
	});
	jobs = [detail.job];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/config")) return json(config);
			if (url.endsWith("/api/jobs") && method === "GET") return json(jobs);
			if (url.includes("/jobs") && method === "POST")
				return json(
					makeJob({ id: "33333333-3333-4333-8333-333333333333" }),
					201,
				);
			if (url.includes("/api/jobs/")) return json(detail);
			return json({ error: "NOT_FOUND" }, 404);
		}),
	);
	renderApp();
	fireEvent.click(
		await screen.findByText("LLMとWeb探索", { selector: ".job-link span" }),
	);
	expect(await screen.findByText("レポートは生成されていません")).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: /Knowledge/ }));
	expect(screen.getByText(/Memoryがない場合があります/)).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: /知見と根拠/ }));
	expect(screen.getByText(/検証済みのClaimはまだありません/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /このテーマでWeb調査/ }));
	detail = makeDetail({
		job: makeJob({ status: "cancel_requested" }),
		artifacts: [
			makeArtifact({
				sections: undefined,
				qualityState: "needs_revision",
			}),
		],
		qualityReviews: [{ version: 1, review: { verdict: "revise", scores: {} } }],
		sources: [makeSource({ truncated: true })],
	});
	cleanup();
	jobs = [detail.job];
	renderApp();
	fireEvent.click(
		await screen.findByText("LLMとWeb探索", { selector: ".job-link span" }),
	);
	expect(await screen.findByText("中止処理中…")).toBeTruthy();
	expect(screen.getByText(/要改稿/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /根拠を確認/ }));
	expect(await screen.findByText(/本文は取得上限で切れています/)).toBeTruthy();
});

test("delete dialog cancel is ignored while pending and RoundProgress reports 409", async () => {
	const cancelled: string[] = [];
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<DeleteResearchDialog
				topic="x"
				pending
				error={null}
				onCancel={() => cancelled.push("no")}
				onDelete={() => {}}
			/>
		</QueryClientProvider>,
	);
	fireEvent(
		screen.getByRole("dialog"),
		new Event("cancel", { bubbles: true, cancelable: true }),
	);
	expect(cancelled).toEqual([]);
	cleanup();
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			calls += 1;
			return json({ error: "conflict" }, 409);
		}),
	);
	render(
		<QueryClientProvider client={client}>
			<RoundProgress
				detail={makeDetail({
					job: makeJob({ status: "running" }),
					research: makeResearch({
						slot: { state: "idle", jobId: null, operationKey: null },
					}),
				})}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "優先する" }));
	expect(await screen.findByText(/状態が更新されました/)).toBeTruthy();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json({ error: "nope" }, 500)),
	);
	fireEvent.click(screen.getByRole("button", { name: "優先する" }));
	expect(await screen.findByText(/更新できませんでした/)).toBeTruthy();
	expect(calls).toBeGreaterThan(0);
});

test("delete dialog cancel works when idle and research progress shows subject delay", async () => {
	const cancelled: string[] = [];
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const focus = document.createElement("button");
	document.body.append(focus);
	focus.focus();
	const view = render(
		<QueryClientProvider client={client}>
			<DeleteResearchDialog
				topic="x"
				pending={false}
				error="削除に失敗しました"
				onCancel={() => cancelled.push("yes")}
				onDelete={() => {}}
			/>
		</QueryClientProvider>,
	);
	expect(screen.getByRole("alert").textContent).toContain("失敗");
	fireEvent(
		screen.getByRole("dialog"),
		new Event("cancel", { bubbles: true, cancelable: true }),
	);
	expect(cancelled).toEqual(["yes"]);
	view.unmount();
	expect(document.activeElement).toBe(focus);
	focus.remove();
	render(
		<QueryClientProvider client={client}>
			<ResearchProgress
				unavailable
				detail={makeDetail({
					job: makeJob({ status: "queued" }),
					operations: [
						{
							id: "crawl:https://example.org:1",
							state: "intent",
							startedAt: Date.now() - 20_000,
						},
					],
				})}
			/>
		</QueryClientProvider>,
	);
	expect(screen.getByText(/進捗を取得できません/)).toBeTruthy();
	expect(screen.getByText("https://example.org")).toBeTruthy();
	expect(screen.getByText(/更新が届いていません/)).toBeTruthy();
});

test("PDF evidence drawer shows physical page and unread coverage", async () => {
	detail = makeDetail({ job: completed.job });
	jobs = [detail.job];
	const source = detail.sources[0];
	source.pdf = {
		rawHash: "fixture",
		pages: 3,
		coverage: "partial",
		pageMap: [
			{
				page: 2,
				start: 0,
				end: source.text.length,
				status: "extracted",
				layout: "single-column",
				method: "embedded-text",
				warnings: [],
			},
		],
		omittedPages: [{ from: 3, to: 3, reason: "PDF_PAGE_LIMIT" }],
	};
	renderApp();
	fireEvent.click(
		await screen.findByText("LLMとWeb探索", { selector: ".job-link span" }),
	);
	await screen.findByText("Research Artifact");
	fireEvent.click(screen.getByRole("tab", { name: /知見と根拠/ }));
	fireEvent.click(screen.getByRole("button", { name: /Evidenceを開く/ }));
	await screen.findByLabelText("Evidence詳細");
	expect(
		screen.getByText("PDFページ（ファイル先頭から）").nextElementSibling
			?.textContent,
	).toBe("2");
	expect(
		screen.getByRole("link", { name: /原典を開く/ }).getAttribute("href"),
	).toBe(`${source.finalUrl}#page=2`);
	expect(screen.getByText(/上限で未取得: 3–3ページ/)).toBeTruthy();
});
