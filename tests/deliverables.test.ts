import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, mocks } from "../apps/worker/engine";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { SearchProviderError } from "../packages/search-provider";
import { terminal } from "../packages/core";
import { hash } from "../packages/crawler";
import { htmlNavigation } from "../packages/crawler/links";
import {
	materialize,
	type Draft,
	type ResearchAction,
	actionSchema,
} from "../packages/research/deliverables";
const empty: Draft = {
	sections: [],
	knowledge: [],
	limitations: [],
	openQuestions: [],
};
const episode = {
	title: "調査全体",
	context: "固定資料で実行",
	intent: "仕組みと条件を理解",
	observations: "本文と続きから確認",
	decisions: ["続きの原典を優先"],
	actionTaken: "検索して本文とリンク先を読んだ",
	outcome: "説明を保存した",
	outcomeKind: "success",
	failedApproach: [],
	lesson: "続きの資料を読んで条件を確認",
	triggers: ["調査"],
	openLoops: [],
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "delivery-test-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	const job = store.create(
		createJobSchema.parse({
			topic: "仕組みと条件",
			budget: { tokens: 500000 },
		}),
	);
	job.config.researchFlow = "deliverables-v1";
	store.saveJob(job);
	return {
		dir,
		store,
		job,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
async function run(e: Engine, id: string) {
	for (let i = 0; i < 80 && !terminal(e.store.getJob(id)?.status ?? ""); i++)
		await e.tick(id);
}
test("HTML retains contextual body links, continuation and headings without footer or script execution", () => {
	const n = htmlNavigation(
		'<main><h2>復号</h2><p>具体例は<a href="/next" rel="next">次章</a>を参照</p><a href="javascript:alert(1)">bad</a></main><footer><a href="/login">ログイン</a></footer>',
		"https://example.com/page",
	);
	expect(n.links).toEqual([
		{
			url: "https://example.com/next",
			text: "次章",
			context: "具体例は次章を参照",
			section: "復号",
			kind: "continuation",
		},
	]);
	expect(n.headings).toEqual(["復号"]);
	expect(
		actionSchema.safeParse({ kind: "read", sourceId: "x", done: true }).success,
	).toBe(false);
});
test("link-first flow updates real artifacts, preserves citations, and produces one Episode without intermediate LLM stages", async () => {
	const s = setup();
	const calls: string[] = [];
	const fetched: string[] = [];
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async submit() {
						return { id: "search", cost: 0 };
					},
					async poll() {
						return {
							ready: true,
							cost: 0,
							hits: [
								{
									url: "https://example.com/intro",
									title: "入門",
									snippet: "入口",
									rank: 1,
								},
								{
									url: "https://other.test/result",
									title: "別候補",
									snippet: "別",
									rank: 2,
								},
							],
						};
					},
				},
				crawler: {
					...mocks.crawler,
					async crawl(url) {
						fetched.push(url);
						const base = await mocks.crawler.crawl(
							url,
							new AbortController().signal,
						);
						const text = url.endsWith("intro")
							? "Pointers reconstruct repeated bytes exactly."
							: "Short matches can cost more than literals.";
						return {
							...base,
							text,
							hash: hash(text),
							links: url.endsWith("intro")
								? [
										{
											url: "https://example.com/next",
											text: "続き",
											context: "具体例と条件",
											kind: "continuation" as const,
											section: "復号",
										},
									]
								: [],
						};
					},
				},
				llm: {
					async complete(kind, input) {
						calls.push(kind);
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						if (!d.newContent)
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "fetch",
										url: d.discoveries[0].url,
										purpose: "入門から定義を確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						const src = d.newContent;
						const paragraph = {
							text: src.lines.map((l: { text: string }) => l.text).join(""),
							kind: "finding",
							citations: [
								{
									sourceId: src.sourceId,
									firstLine: src.lines[0].number,
									lastLine: src.lines[src.lines.length - 1].number,
								},
							],
						};
						return {
							text: JSON.stringify({
								draft: {
									...empty,
									sections: [
										{
											title: "仕組みと適用条件",
											paragraphs: [
												...(d.draft.sections[0]?.paragraphs ?? []),
												paragraph,
											],
										},
									],
								},
								next:
									calls.length === 2
										? {
												kind: "fetch",
												url: "https://example.com/next",
												purpose: "本文で参照された条件を確認",
											}
										: {
												kind: "finish",
												satisfied: true,
												reason: "仕組みと条件を説明できた",
											},
							}),
							usage: 100,
							audit: {},
						};
					},
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const d = s.store.detail(s.job.id)!;
		expect(d.job.status).toBe("completed");
		expect(calls).toEqual([
			"deliverable_step",
			"deliverable_step",
			"deliverable_step",
			"deliverable_episode",
		]);
		expect(fetched).toEqual([
			"https://example.com/intro",
			"https://example.com/next",
		]);
		expect(d.artifacts[0].sections?.[0].paragraphs).toHaveLength(2);
		expect(d.memory?.[0].episodes).toHaveLength(1);
		expect(d.memory?.[0].episodes[0].title).toBe(episode.title);
		expect(d.memory?.[0].episodes[0].id).toBe(`episode:${s.job.id}`);
		expect(d.claims.every((c) => c.evidenceIds.length)).toBe(true);
		expect(d.artifacts.length).toBe(3);
	} finally {
		s.close();
	}
});
test("search results are compared and four failed fetches allow a focused search and recovery", async () => {
	const s = setup();
	const fetched: string[] = [];
	const queries: string[] = [];
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async submit(q) {
						queries.push(q);
						return { id: String(queries.length), cost: 0 };
					},
					async poll() {
						return {
							ready: true,
							cost: 0,
							hits: (queries.length === 1
								? ["noise", "a", "b", "c", "d"]
								: ["answer"]
							).map((name, i) => ({
								url: `https://example.com/${name}`,
								title: name,
								snippet: `meaning of ${name}`,
								rank: i + 1,
							})),
						};
					},
				},
				crawler: {
					...mocks.crawler,
					async crawl(url, signal) {
						fetched.push(url);
						if (!url.endsWith("answer")) throw Error("GUARD_DENIED");
						return mocks.crawler.crawl(url, signal);
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						let output: unknown;
						if (kind === "deliverable_episode") output = episode;
						else if (d.newContent)
							output = {
								draft: {
									...empty,
									sections: [
										{
											title: "回答",
											paragraphs: [
												{
													text: d.newContent.lines[0].text,
													kind: "finding",
													citations: [
														{
															sourceId: d.newContent.sourceId,
															firstLine: 1,
															lastLine: 1,
														},
													],
												},
											],
										},
									],
								},
								next: {
									kind: "finish",
									satisfied: true,
									reason: "本文で回答確認",
								},
							};
						else {
							expect(
								d.discoveries.every((h: { snippet: string }) =>
									h.snippet.startsWith("meaning"),
								),
							).toBe(true);
							const count = d.consecutiveFailures;
							output = {
								draft: null,
								next:
									count === 4 && queries.length === 1
										? {
												kind: "search",
												query: "具体的な意味と仕組み",
												purpose: "別の意味を識別する",
											}
										: {
												kind: "fetch",
												url: `https://example.com/${queries.length === 2 ? "answer" : ["a", "b", "c", "d"][count]}`,
												purpose: "不足する定義を確認",
											},
							};
						}
						return { text: JSON.stringify(output), usage: 100, audit: {} };
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(e, s.job.id);
		const d = s.store.detail(s.job.id)!;
		expect(d.job.status).toBe("completed");
		expect(queries).toEqual(["仕組みと条件", "具体的な意味と仕組み"]);
		expect(fetched.map((u) => u.split("/").pop())).toEqual([
			"a",
			"b",
			"c",
			"d",
			"answer",
		]);
		expect(d.artifacts).toHaveLength(2);
		expect(d.events.filter((e) => e.type === "research.decision")).toHaveLength(
			7,
		);
		expect(d.memory?.[0].episodes).toHaveLength(1);
	} finally {
		s.close();
	}
});
test("persistent retrieval failures are bounded after reconsideration without retrying URLs", async () => {
	const s = setup();
	let fetches = 0;
	let writerCalls = 0;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async submit() {
						return { id: "x", cost: 0 };
					},
					async poll() {
						return {
							ready: true,
							cost: 0,
							hits: Array.from({ length: 10 }, (_, i) => ({
								url: `https://example.com/${i}`,
								title: String(i),
								snippet: "候補",
								rank: i + 1,
							})),
						};
					},
				},
				crawler: {
					...mocks.crawler,
					async crawl(url, signal) {
						fetches++;
						if (fetches === 1) return mocks.crawler.crawl(url, signal);
						throw Error("GUARD_DENIED");
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_step") {
							writerCalls++;
							expect(d.finalizing).toBe(false);
						}
						if (d.newContent) {
							const line = d.newContent.lines[0];
							return {
								text: JSON.stringify({
									draft: {
										...empty,
										sections: [
											{
												title: "検証済み説明",
												paragraphs: [
													{
														text: line.text,
														kind: "finding",
														citations: [
															{
																sourceId: d.newContent.sourceId,
																firstLine: line.number,
																lastLine: line.number,
															},
														],
													},
												],
											},
										],
										openQuestions: ["独立資料で確認する"],
									},
									next: {
										kind: "fetch",
										url: d.discoveries[0].url,
										purpose: "独立資料",
									},
								}),
								usage: 100,
								audit: {},
							};
						}
						return {
							text: JSON.stringify(
								kind === "deliverable_episode"
									? { ...episode, outcomeKind: "failure" }
									: {
											draft: null,
											next: d.finalizing
												? {
														kind: "finish",
														satisfied: false,
														reason: "取得経路の制約",
													}
												: {
														kind: "fetch",
														url: d.discoveries[0].url,
														purpose: "別候補を確認",
													},
										},
							),
							usage: 100,
							audit: {},
						};
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(e, s.job.id);
		expect(fetches).toBe(9);
		expect(writerCalls).toBe(9);
		expect(s.store.getJob(s.job.id)?.reason).toBe("retrieval_recovery_limit");
		const detail = s.store.detail(s.job.id)!;
		expect(detail.claims.length).toBeGreaterThan(0);
		const artifacts = [...detail.artifacts].sort(
			(a, b) => a.version - b.version,
		);
		expect(artifacts.at(-1)?.body).toBe(artifacts[0].body);
		expect(artifacts.at(-1)?.claimIds).toEqual(artifacts[0].claimIds);
		expect(
			detail.events.some(
				(event) =>
					event.type === "research.decision" &&
					(event.data as { actor?: string }).actor === "runtime",
			),
		).toBe(true);
	} finally {
		s.close();
	}
});
test("fabricated quotes and incomplete procedures cannot be materialized", async () => {
	const source = await mocks.crawler.crawl(
		"https://example.com",
		new AbortController().signal,
	);
	expect(() =>
		materialize(
			{
				...empty,
				sections: [
					{
						title: "x",
						paragraphs: [
							{
								text: "invented",
								kind: "finding",
								citations: [{ sourceId: source.id, quote: "not in source" }],
							},
						],
					},
				],
			},
			[source],
			"j",
			1,
			"x",
		),
	).toThrow("QUOTE_NOT_IN_SNAPSHOT");
	expect(() =>
		materialize(
			{
				...empty,
				knowledge: [
					{
						type: "procedure",
						polarity: "positive",
						title: "x",
						body: "x",
						appliesWhen: [],
						notApplicableWhen: [],
						steps: ["x"],
						verification: [],
						unknowns: [],
						skill: null,
						citations: [{ sourceId: source.id, quote: source.text }],
					},
				],
			},
			[source],
			"j",
			1,
			"x",
		),
	).toThrow("INCOMPLETE_SKILL");
});

test("low budget publishes a truthful fallback without starting an unaffordable LLM call", async () => {
	const s = setup();
	try {
		const source = await mocks.crawler.crawl(
			"https://example.com",
			new AbortController().signal,
		);
		s.store.put(s.job.id, "source", source.id, source);
		s.job.config.deliveryReplay = { sourceId: source.id };
		s.job.budget.tokens = 4096;
		s.store.saveJob(s.job);
		let calls = 0;
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete() {
						calls++;
						throw Error("should not call");
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(e, s.job.id);
		const d = s.store.detail(s.job.id)!;
		expect(calls).toBe(0);
		expect(d.job.status).toBe("partial");
		expect(d.job.reason).toBe("token_budget");
		expect(d.memory?.[0].episodes).toHaveLength(1);
		expect(
			d.memory?.[0].episodes[0].eventIds.every((id) =>
				d.memory?.[0].events.some((e) => e.id === id),
			),
		).toBe(true);
	} finally {
		s.close();
	}
});

test("invalid citations get one bounded correction, then publish the last valid draft", async () => {
	const s = setup();
	try {
		const source = await mocks.crawler.crawl(
			"https://example.com",
			new AbortController().signal,
		);
		s.store.put(s.job.id, "source", source.id, source);
		s.job.config.deliveryReplay = { sourceId: source.id };
		s.store.saveJob(s.job);
		const calls: string[] = [];
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(kind) {
						calls.push(kind);
						return {
							usage: 100,
							audit: {},
							text: JSON.stringify(
								kind === "deliverable_episode"
									? episode
									: {
											draft: {
												...empty,
												sections: [
													{
														title: "x",
														paragraphs: [
															{
																text: "x",
																kind: "finding",
																citations: [
																	{
																		sourceId: source.id,
																		quote: "fabricated evidence",
																	},
																],
															},
														],
													},
												],
											},
											next: { kind: "finish", satisfied: true, reason: "x" },
										},
							),
						};
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(e, s.job.id);
		expect(s.store.getJob(s.job.id)?.reason).toBe("invalid_deliverable");
		expect(calls).toEqual([
			"deliverable_step",
			"deliverable_step",
			"deliverable_episode",
		]);
		expect(s.store.detail(s.job.id)?.claims).toHaveLength(0);
	} finally {
		s.close();
	}
});

test("direct search performs no LLM preprocessing and surfaces provider failure", async () => {
	const { DirectSearch } = await import("../packages/search-provider/direct");
	const s = new DirectSearch({
		name: "test",
		async search(input) {
			expect(input.query).toBe("topic");
			return [
				{
					provider: "test",
					rank: 1,
					title: "source",
					url: "https://example.com",
					snippet: "intro",
				},
			];
		},
	});
	expect(await s.suggest()).toEqual({ suggestions: [], cost: 0 });
	const submitted = await s.submit("topic");
	expect(
		(await s.poll(submitted.id, new AbortController().signal)).hits,
	).toHaveLength(1);
	const failed = new DirectSearch({
		name: "test",
		async search() {
			throw Error("offline");
		},
	});
	await expect(failed.poll("x", new AbortController().signal)).rejects.toThrow(
		"offline",
	);
	const timedOut = new DirectSearch({
		name: "test",
		async search() {
			throw Error("DuckDuckGo search timed out.");
		},
	});
	await expect(
		timedOut.poll("x", new AbortController().signal),
	).rejects.toMatchObject({ retryable: true });
});

test("provider schema uses supported anyOf rather than oneOf for actions", async () => {
	const { groundedSchema, strictSchema } = await import(
		"../packages/llm-provider/codex"
	);
	const schema = JSON.stringify(
		strictSchema(groundedSchema("deliverable_step", "{}")),
	);
	expect(schema).not.toContain('"oneOf"');
	expect(schema).toContain('"anyOf"');
});

test("whitespace-normalized citations retain original snapshot bytes and reject omissions", async () => {
	const source = await mocks.crawler.crawl(
		"https://example.com",
		new AbortController().signal,
	);
	source.text = "Repeat bytes\n  using a pointer and length.";
	source.hash = hash(source.text);
	const draft = {
		...empty,
		sections: [
			{
				title: "Pointers",
				paragraphs: [
					{
						text: "A pointer describes repeated bytes.",
						kind: "finding" as const,
						citations: [
							{
								sourceId: source.id,
								quote: "Repeat bytes using a pointer and length.",
							},
						],
					},
				],
			},
		],
	};
	const r = materialize(draft, [source], "j", 1, "Pointers");
	expect(r.evidence[0].quote).toBe(source.text);
	draft.sections[0].paragraphs[0].citations[0].quote =
		"Repeat bytes ... length.";
	expect(() => materialize(draft, [source], "j", 1, "Pointers")).toThrow(
		"QUOTE_NOT_IN_SNAPSHOT",
	);
});

test("complete Skills export a safe discovery name and all executable task fields", async () => {
	const { skillMarkdown, skillName } = await import(
		"../packages/research/deliverables"
	);
	const markdown = skillMarkdown({
		type: "procedure",
		polarity: "positive",
		title: "確認手順",
		body: "入力と期待出力を照合する。",
		appliesWhen: ["固定例を確認するとき"],
		notApplicableWhen: [],
		steps: ["入力を読み取る", "期待出力と照合する"],
		verification: ["期待出力との完全一致"],
		unknowns: [],
		citations: [],
		skill: {
			name: "入力を確認",
			description: "固定例の入出力を照合する際に使用する。",
			inputs: ["固定入力と期待出力"],
			outputs: ["一致結果"],
			prerequisites: ["期待出力が既知"],
			failureHandling: ["不一致の場合は完了にしない"],
		},
	});
	expect(skillName("../../a/b")).toBe("a-b");
	expect(markdown).toContain('name: "research-');
	expect(markdown).toContain("不一致の場合は完了にしない");
	expect(markdown).toContain("期待出力との完全一致");
});

test("numbered citations resolve to original Unicode text and reject nonexistent lines", async () => {
	const { sourceLines } = await import("../packages/research/deliverables");
	const source = await mocks.crawler.crawl(
		"https://example.com",
		new AbortController().signal,
	);
	source.text = "概要です。\n元の値を復元します。😀\n条件を確認します。";
	source.hash = hash(source.text);
	const lines = sourceLines(source.text);
	expect(lines.map((l) => l.text).join("")).toBe(source.text);
	const draft = {
		...empty,
		sections: [
			{
				title: "復元",
				paragraphs: [
					{
						text: "元の値を復元し、条件を確認します。",
						kind: "finding" as const,
						citations: [{ sourceId: source.id, firstLine: 2, lastLine: 3 }],
					},
				],
			},
		],
	};
	const r = materialize(draft, [source], "j", 1, "復元");
	expect(r.evidence[0].quote).toBe(
		"元の値を復元します。😀\n条件を確認します。",
	);
	expect(source.text.slice(r.evidence[0].start, r.evidence[0].end)).toBe(
		r.evidence[0].quote,
	);
	draft.sections[0].paragraphs[0].citations[0].lastLine = 999;
	expect(() => materialize(draft, [source], "j", 1, "復元")).toThrow(
		"QUOTE_NOT_IN_SNAPSHOT",
	);
});

test("zero-hit results are explicit and an unresolved finish with budget is reconsidered", async () => {
	const s = setup();
	const queries: string[] = [];
	let reconsidered = false;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				crawler: {
					...mocks.crawler,
					async crawl(url, signal) {
						const source = await mocks.crawler.crawl(url, signal);
						return {
							...source,
							text: `Independent comparison from ${url}.`,
							hash: hash(`Independent comparison from ${url}.`),
						};
					},
				},
				search: {
					...mocks.search,
					async submit(q) {
						queries.push(q);
						return { id: String(queries.length), cost: 0 };
					},
					async poll() {
						return {
							ready: true,
							cost: 0,
							hits:
								queries.length === 1
									? []
									: [
											{
												url: `https://example.com/${queries.length}`,
												title: "原典",
												snippet: "具体例と比較",
												rank: 1,
											},
										],
						};
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						let result: unknown;
						if (kind === "deliverable_episode") result = episode;
						else if (d.validationError) {
							reconsidered = true;
							expect(d.navigationOnly).toBe(true);
							expect(d.draft).toBeUndefined();
							result = {
								draft: null,
								next: {
									kind: "search",
									query: "別の方式との比較",
									purpose: "残る比較を調べる",
								},
							};
						} else if (d.newContent) {
							const paragraphs = [
								...(d.draft.sections[0]?.paragraphs ?? []),
								{
									text: d.newContent.lines[0].text,
									kind: "finding",
									citations: [
										{
											sourceId: d.newContent.sourceId,
											firstLine: 1,
											lastLine: 1,
										},
									],
								},
							];
							result = {
								draft: {
									...empty,
									sections: [{ title: "説明", paragraphs }],
									openQuestions: queries.length === 2 ? ["方式の比較"] : [],
								},
								next: {
									kind: "finish",
									satisfied: queries.length === 3,
									reason: "読解範囲",
								},
							};
						} else {
							expect(d.navigationOnly).toBe(true);
							expect(d.draft).toBeUndefined();
							expect(d.lastSearch.query).toBe(queries.at(-1));
							result = {
								draft: null,
								next:
									d.lastSearch.hitCount === 0
										? {
												kind: "search",
												query: "key value memory networks",
												purpose: "引用符を外して展開語で調べる",
											}
										: {
												kind: "fetch",
												url: d.discoveries.find((q: { url: string }) =>
													d.lastSearch.newUrls.includes(q.url),
												).url,
												purpose: "本文で確認",
											},
							};
						}
						return { text: JSON.stringify(result), usage: 100, audit: {} };
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(e, s.job.id);
		expect(reconsidered).toBe(true);
		expect(queries).toHaveLength(3);
		expect(s.store.getJob(s.job.id)?.status).toBe("completed");
		expect(
			s.store.detail(s.job.id)?.artifacts[0].sections?.[0].paragraphs,
		).toHaveLength(2);
	} finally {
		s.close();
	}
});

test("a deferred draft after reading is corrected before exploration can continue", async () => {
	const s = setup();
	let deferred = false;
	let corrected = false;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						let output: unknown;
						if (!d.newContent)
							output = {
								draft: null,
								next: {
									kind: "fetch",
									url: d.discoveries[0].url,
									purpose: "本文を確認",
								},
							};
						else if (!deferred) {
							deferred = true;
							output = {
								draft: null,
								next: { kind: "finish", satisfied: true, reason: "先送り" },
							};
						} else {
							expect(d.validationError).toContain(
								"READ_CONTENT_REQUIRES_DRAFT_UPDATE",
							);
							corrected = true;
							const line = d.newContent.lines[0];
							output = {
								draft: {
									...empty,
									sections: [
										{
											title: "確認できた内容",
											paragraphs: [
												{
													text: line.text,
													kind: "finding",
													citations: [
														{
															sourceId: d.newContent.sourceId,
															firstLine: line.number,
															lastLine: line.number,
														},
													],
												},
											],
										},
									],
								},
								next: { kind: "finish", satisfied: true, reason: "説明を保存" },
							};
						}
						return { text: JSON.stringify(output), usage: 100, audit: {} };
					},
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		expect(corrected).toBe(true);
		expect(s.store.detail(s.job.id)!.job.status).toBe("completed");
		expect(s.store.detail(s.job.id)!.artifacts.at(-1)?.sections?.length).toBe(
			1,
		);
	} finally {
		s.close();
	}
});

test("search refusal preserves known candidates without retrying the search service", async () => {
	const s = setup();
	let polls = 0;
	let recovered = false;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async poll(...args) {
						polls++;
						if (polls > 1)
							throw new SearchProviderError("bot challenge", false);
						return mocks.search.poll(...args);
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						let output: unknown;
						if (d.newContent) {
							const line = d.newContent.lines[0];
							output = {
								draft: {
									...empty,
									sections: [
										{
											title: "確認した本文",
											paragraphs: [
												{
													text: line.text,
													kind: "finding",
													citations: [
														{
															sourceId: d.newContent.sourceId,
															firstLine: line.number,
															lastLine: line.number,
														},
													],
												},
											],
										},
									],
								},
								next: {
									kind: "finish",
									satisfied: true,
									reason: "本文で説明を確認",
								},
							};
						} else if (d.searchUnavailable) {
							expect(d.remainingQueries).toBe(0);
							recovered = true;
							output = {
								draft: null,
								next: {
									kind: "fetch",
									url: d.discoveries[0].url,
									purpose: "検索済みの候補を確認",
								},
							};
						} else
							output = {
								draft: null,
								next: {
									kind: "search",
									query: "additional angle",
									purpose: "別の切り口を確認",
								},
							};
						return { text: JSON.stringify(output), usage: 100, audit: {} };
					},
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		expect(recovered).toBe(true);
		expect(polls).toBe(2);
		expect(s.store.detail(s.job.id)!.job.status).toBe("completed");
		expect(s.store.detail(s.job.id)!.artifacts.at(-1)?.sections).toHaveLength(
			1,
		);
	} finally {
		s.close();
	}
});

test("one transient search timeout allows a distinct fallback query", async () => {
	const s = setup();
	let polls = 0;
	let sawRetryableState = false;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async poll(...args) {
						polls++;
						if (polls === 1)
							throw new SearchProviderError(
								"DuckDuckGo search timed out.",
								true,
							);
						return mocks.search.poll(...args);
					},
				},
				llm: {
					async complete(kind, input) {
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						const d = JSON.parse(input);
						if (!d.newContent && d.discoveries.length === 0) {
							sawRetryableState =
								d.searchUnavailable === null && d.remainingQueries > 0;
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "search",
										query: "expanded fallback query",
										purpose: "一時失敗後に別表現で確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						}
						if (!d.newContent)
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "fetch",
										url: d.discoveries[0].url,
										purpose: "代替検索で見つけた本文を確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						const line = d.newContent.lines[0];
						return {
							text: JSON.stringify({
								draft: {
									...empty,
									sections: [
										{
											title: "確認結果",
											paragraphs: [
												{
													text: line.text,
													kind: "finding",
													citations: [
														{
															sourceId: d.newContent.sourceId,
															firstLine: line.number,
															lastLine: line.number,
														},
													],
												},
											],
										},
									],
								},
								next: { kind: "finish", satisfied: true, reason: "確認済み" },
							}),
							usage: 100,
							audit: {},
						};
					},
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		expect(sawRetryableState).toBe(true);
		expect(polls).toBe(2);
		expect(s.store.detail(s.job.id)!.queries).toHaveLength(2);
		expect(s.store.detail(s.job.id)!.job.status).toBe("completed");
	} finally {
		s.close();
	}
});

test("invalid navigation stays compact and can move from a completed source to new evidence", async () => {
	const s = setup();
	let repaired = false;
	let reads = 0;
	try {
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						let output: unknown;
						if (d.newContent) {
							reads++;
							const line = d.newContent.lines[0];
							output = {
								draft: {
									...empty,
									sections: [
										{
											title: "説明",
											paragraphs: [
												{
													text: line.text,
													kind: "finding",
													citations: [
														{
															sourceId: d.newContent.sourceId,
															firstLine: line.number,
															lastLine: line.number,
														},
													],
												},
											],
										},
									],
								},
								next:
									reads === 1
										? {
												kind: "search",
												query: "independent comparison",
												purpose: "別の根拠を調べる",
											}
										: {
												kind: "finish",
												satisfied: true,
												reason: "別資料を確認",
											},
							};
						} else if (d.validationError) {
							expect(d.validationError).toContain("SOURCE_ALREADY_READ");
							expect(d.navigationOnly).toBe(true);
							expect(d.draft).toBeUndefined();
							expect(d.readableSourceIds).toEqual([]);
							repaired = true;
							output = {
								draft: null,
								next: {
									kind: "fetch",
									url: d.discoveries[0].url,
									purpose: "未取得の独立資料へ進む",
								},
							};
						} else if (d.sources.length)
							output = {
								draft: null,
								next: {
									kind: "read",
									sourceId: d.sources[0].id,
									purpose: "誤った再読",
								},
							};
						else
							output = {
								draft: null,
								next: {
									kind: "fetch",
									url: d.discoveries[0].url,
									purpose: "最初の本文",
								},
							};
						return { text: JSON.stringify(output), usage: 100, audit: {} };
					},
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		expect(repaired).toBe(true);
		expect(reads).toBe(2);
		expect(s.store.detail(s.job.id)!.job.status).toBe("completed");
	} finally {
		s.close();
	}
});

test("long document indexes retain late reference links in the reader input", async () => {
	const s = setup();
	let sawLateLink = false;
	try {
		const navigation = htmlNavigation(
			`<main>${Array.from({ length: 150 }, (_, i) => `<a href="/chapter-${i}">Chapter ${i}</a>`).join("")}</main>`,
			"https://example.com/index",
		);
		expect(navigation.links?.at(-1)?.url).toBe(
			"https://example.com/chapter-149",
		);
		const engine = new Engine(
			s.store,
			() => ({
				...mocks,
				crawler: {
					...mocks.crawler,
					async crawl(url, signal) {
						return {
							...(await mocks.crawler.crawl(url, signal)),
							...navigation,
						};
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						if (!d.newContent)
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "fetch",
										url: d.discoveries[0].url,
										purpose: "索引を確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						const source = d.sources.find(
							(source: { id: string }) => source.id === d.newContent.sourceId,
						);
						sawLateLink = source.links.some(
							(link: { url: string }) =>
								link.url === "https://example.com/chapter-149",
						);
						const line = d.newContent.lines[0];
						return {
							text: JSON.stringify({
								draft: {
									...empty,
									sections: [
										{
											title: "説明",
											paragraphs: [
												{
													text: line.text,
													kind: "finding",
													citations: [
														{
															sourceId: source.id,
															firstLine: line.number,
															lastLine: line.number,
														},
													],
												},
											],
										},
									],
								},
								next: { kind: "finish", satisfied: true, reason: "索引確認" },
							}),
							usage: 100,
							audit: {},
						};
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(engine, s.job.id);
		expect(sawLateLink).toBe(true);
		expect(s.store.getJob(s.job.id)?.status).toBe("completed");
	} finally {
		s.close();
	}
});

test("identical HTML text at another URL retains new links without rewriting evidence", async () => {
	const s = setup();
	let reads = 0;
	let duplicates = 0;
	try {
		const engine = new Engine(
			s.store,
			() => ({
				...mocks,
				crawler: {
					...mocks.crawler,
					async crawl(url, signal) {
						const source = await mocks.crawler.crawl(url, signal);
						return {
							...source,
							text: "Reusable explanation with conditions.",
							hash: hash("Reusable explanation with conditions."),
							links: [
								{
									url: url.endsWith("/extra")
										? "https://example.com/late"
										: "https://example.com/extra",
									text: "Additional example",
									context: "Example",
									section: "",
									kind: "reference" as const,
								},
							],
						};
					},
				},
				llm: {
					async complete(kind, input) {
						const d = JSON.parse(input);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						let draft = null;
						let next: ResearchAction;
						if (d.newContent) {
							reads++;
							const line = d.newContent.lines[0];
							draft = {
								...empty,
								sections: [
									{
										title: "説明",
										paragraphs: [
											{
												text: line.text,
												kind: "finding",
												citations: [
													{
														sourceId: d.newContent.sourceId,
														firstLine: line.number,
														lastLine: line.number,
													},
												],
											},
										],
									},
								],
							};
							next = {
								kind: "fetch",
								url: "https://example.com/extra",
								purpose: "追加の例",
							};
						} else if (d.sources.length) {
							duplicates++;
							expect(
								d.discoveries.some(
									(q: { url: string }) => q.url === "https://example.com/late",
								),
							).toBe(true);
							expect(d.navigationOnly).toBe(true);
							next = {
								kind: "finish",
								satisfied: true,
								reason: "同一本文を確認",
							};
						} else
							next = {
								kind: "fetch",
								url: d.discoveries[0].url,
								purpose: "本文を確認",
							};
						return {
							text: JSON.stringify({ draft, next }),
							usage: 100,
							audit: {},
						};
					},
				},
			}),
			join(s.dir, "out"),
		);
		await run(engine, s.job.id);
		expect(reads).toBe(1);
		expect(duplicates).toBe(1);
		expect(s.store.detail(s.job.id)?.sources).toHaveLength(1);
		expect(s.store.getJob(s.job.id)?.status).toBe("completed");
	} finally {
		s.close();
	}
});
