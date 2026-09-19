import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, mocks, type Providers } from "../apps/worker/engine";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { terminal } from "../packages/core";
import { hash } from "../packages/crawler";
import type { DiscoveryInput } from "../packages/research/world-model-schema";

const episode = {
	title: "調査全体",
	context: "固定資料で実行",
	intent: "仕組みと条件を理解",
	observations: "本文から確認",
	decisions: ["入口を読む"],
	actionTaken: "検索して本文を読んだ",
	outcome: "説明を保存した",
	outcomeKind: "success",
	failedApproach: [],
	lesson: "条件を確認",
	triggers: ["調査"],
	openLoops: [],
};

function setup(discoveryVersion?: number) {
	const dir = mkdtempSync(join(tmpdir(), "wm-engine-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	const job = store.create(
		createJobSchema.parse({
			topic: "仕組みと条件",
			budget: { tokens: 500000 },
		}),
	);
	job.config.researchFlow = "deliverables-v1";
	if (discoveryVersion !== undefined)
		job.config.worldModelDiscoveryVersion = discoveryVersion;
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

function emptyDiscovery(): DiscoveryInput {
	return {
		changeReason: "根拠付きの関係候補は作れなかった",
		candidates: [],
		gaps: [],
	};
}

function draftFrom(
	content: {
		sourceId: string;
		lines: { number: number; text: string }[];
	},
	discovery: DiscoveryInput | null | undefined,
	extra?: Record<string, unknown>,
) {
	return {
		sections: [
			{
				title: "仕組み",
				paragraphs: [
					{
						text: content.lines
							.map((line) => line.text)
							.join("")
							.slice(0, 400),
						kind: "finding",
						citations: [
							{
								sourceId: content.sourceId,
								firstLine: content.lines[0].number,
								lastLine: content.lines[0].number,
							},
						],
					},
				],
			},
		],
		knowledge: [],
		limitations: [],
		openQuestions: extra?.openQuestions ?? [],
		worldModelDiscovery: discovery,
		...extra,
	};
}

function candidate(sourceId: string, line = 1): DiscoveryInput {
	return {
		changeReason: "条件付きの短縮を候補にした",
		candidates: [
			{
				subject: "技術X",
				relation: "decreases",
				object: "応答待ち時間",
				correlationDirection: null,
				assessment: "hypothesis",
				basis: "inference",
				explanation: "資料は条件付きの短縮を述べている。",
				conditions: ["負荷が低いとき"],
				exceptions: [],
				scope: "実験室",
				alternatives: [],
				evidence: [
					{
						role: "supports",
						method: "experiment",
						note: "著者が待ち時間の低下を報告",
						citations: [{ sourceId, firstLine: line, lastLine: line }],
					},
				],
				gaps: [],
			},
		],
		gaps: [],
	};
}

function providers(llm: Providers["llm"]) {
	return (): Providers => ({
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
					],
				};
			},
		},
		crawler: {
			...mocks.crawler,
			async crawl(url: string) {
				const base = await mocks.crawler.crawl(
					url,
					new AbortController().signal,
				);
				const text = "Technique X reduced wait time under low load.\n";
				return { ...base, text, hash: hash(text) };
			},
		},
		llm,
	});
}

test("W01 first read requires a discovery object and accepts an empty one", async () => {
	const s = setup(1);
	let reads = 0;
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (!data.newContent)
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "fetch",
									url: data.discoveries[0].url,
									purpose: "定義を確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					reads++;
					return {
						text: JSON.stringify({
							draft: draftFrom(
								data.newContent,
								reads === 1 ? undefined : emptyDiscovery(),
							),
							next: {
								kind: "finish",
								satisfied: true,
								reason: "説明できた",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const detail = s.store.detail(s.job.id)!;
		expect(
			detail.events.some((event) =>
				JSON.stringify(event.data).includes(
					"DISCOVERY_INITIAL_RESULT_REQUIRED",
				),
			),
		).toBe(true);
		expect(detail.artifacts.at(-1)?.worldModelDiscovery?.candidates).toEqual(
			[],
		);
		expect(detail.job.status).toBe("completed");
	} finally {
		s.close();
	}
});

test("W02 keeps candidates across navigation and sends summaries only", async () => {
	const s = setup(1);
	const inputs: string[] = [];
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					inputs.push(kind === "deliverable_step" ? input : kind);
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (data.newContent)
						expect(data.discoveryNavigation).toBeUndefined();
					if (!data.newContent) {
						expect(
							JSON.stringify(data.discoveryNavigation ?? {}),
						).not.toContain("資料は条件付きの短縮を述べている。");
						return {
							text: JSON.stringify({
								draft: null,
								next: data.discoveryNavigation?.candidates.length
									? {
											kind: "finish",
											satisfied: true,
											reason: "説明できた",
										}
									: {
											kind: "fetch",
											url: data.discoveries[0].url,
											purpose: "定義を確認",
										},
							}),
							usage: 100,
							audit: {},
						};
					}
					return {
						text: JSON.stringify({
							draft: draftFrom(
								data.newContent,
								candidate(data.newContent.sourceId),
							),
							next: {
								kind: "search",
								query: "条件の反証",
								purpose: "条件を確認",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const detail = s.store.detail(s.job.id)!;
		expect(
			detail.artifacts.at(-1)?.worldModelDiscovery?.candidates,
		).toHaveLength(1);
		expect(detail.job.status).toBe("completed");
	} finally {
		s.close();
	}
});

test("W03 unread discovery citations keep the last valid artifact", async () => {
	const s = setup(1);
	const long = Array.from(
		{ length: 400 },
		(_, i) => `line-${i} ${"x".repeat(80)}`,
	).join("\n");
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
							],
						};
					},
				},
				crawler: {
					...mocks.crawler,
					async crawl(url: string) {
						const base = await mocks.crawler.crawl(
							url,
							new AbortController().signal,
						);
						return { ...base, text: long, hash: hash(long) };
					},
				},
				llm: {
					async complete(kind, input) {
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						const data = JSON.parse(input);
						if (!data.newContent)
							return {
								text: JSON.stringify({
									draft: null,
									next: data.validationError
										? {
												kind: "finish",
												satisfied: true,
												reason: "説明できた",
											}
										: {
												kind: "fetch",
												url: data.discoveries[0].url,
												purpose: "定義を確認",
											},
								}),
								usage: 100,
								audit: {},
							};
						const unread = 350;
						return {
							text: JSON.stringify({
								draft: draftFrom(
									data.newContent,
									data.validationError
										? emptyDiscovery()
										: candidate(data.newContent.sourceId, unread),
								),
								next: {
									kind: "finish",
									satisfied: true,
									reason: "説明できた",
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
		const detail = s.store.detail(s.job.id)!;
		expect(
			detail.events.some((event) =>
				JSON.stringify(event.data).includes("CITATION_NOT_READ"),
			),
		).toBe(true);
		expect(detail.artifacts.at(-1)?.worldModelDiscovery?.candidates).toEqual(
			[],
		);
	} finally {
		s.close();
	}
});

test("W04 required gaps must appear in openQuestions", async () => {
	const s = setup(1);
	try {
		let fetched = false;
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (!data.newContent) {
						if (!fetched) {
							fetched = true;
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "fetch",
										url: data.discoveries[0].url,
										purpose: "定義を確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						}
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "finish",
									satisfied: false,
									reason: "条件が未確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					}
					const discovery = candidate(data.newContent.sourceId);
					discovery.gaps = [
						{
							kind: "missing_condition",
							question: "別負荷でも同じか",
							relevance: "required",
							reason: "条件が足りない",
						},
					];
					return {
						text: JSON.stringify({
							draft: draftFrom(
								data.newContent,
								discovery,
								data.validationError
									? { openQuestions: ["別負荷でも同じか"] }
									: {},
							),
							next: data.validationError
								? {
										kind: "search",
										query: "別負荷",
										purpose: "条件を確認",
									}
								: {
										kind: "finish",
										satisfied: false,
										reason: "条件が未確認",
									},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const detail = s.store.detail(s.job.id)!;
		expect(
			detail.events.some((event) =>
				JSON.stringify(event.data).includes(
					"DISCOVERY_REQUIRED_GAP_NOT_IN_OPEN_QUESTIONS",
				),
			),
		).toBe(true);
		expect(detail.artifacts.at(-1)?.worldModelDiscovery?.gaps[0].question).toBe(
			"別負荷でも同じか",
		);
	} finally {
		s.close();
	}
});

test("W05 optional gaps do not block satisfied finish", async () => {
	const s = setup(1);
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (!data.newContent)
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "fetch",
									url: data.discoveries[0].url,
									purpose: "定義を確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					const discovery = emptyDiscovery();
					discovery.gaps = [
						{
							kind: "unknown_applicability",
							question: "別製品でも同じか",
							relevance: "optional",
							reason: "派生的な問い",
						},
					];
					return {
						text: JSON.stringify({
							draft: draftFrom(data.newContent, discovery),
							next: {
								kind: "finish",
								satisfied: true,
								reason: "中心の説明は足りた",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const detail = s.store.detail(s.job.id)!;
		expect(detail.job.status).toBe("completed");
		expect(detail.artifacts.at(-1)?.worldModelDiscovery?.gaps).toHaveLength(1);
	} finally {
		s.close();
	}
});

test("W06 repeated invalid discovery uses the existing partial finish without extra retries", async () => {
	const s = setup(1);
	const kinds: string[] = [];
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					kinds.push(kind);
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (!data.newContent)
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "fetch",
									url: data.discoveries[0].url,
									purpose: "定義を確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					return {
						text: JSON.stringify({
							draft: draftFrom(data.newContent, undefined),
							next: {
								kind: "finish",
								satisfied: true,
								reason: "説明できた",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		expect(kinds.filter((kind) => kind === "deliverable_step")).toHaveLength(3);
		expect(s.store.getJob(s.job.id)?.status).toBe("partial");
		expect(s.store.getJob(s.job.id)?.reason).toBe("invalid_deliverable");
	} finally {
		s.close();
	}
});

test("W07 reopening the store keeps discovery ids and citations", async () => {
	const s = setup(1);
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					if (!data.newContent)
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "fetch",
									url: data.discoveries[0].url,
									purpose: "定義を確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					return {
						text: JSON.stringify({
							draft: draftFrom(
								data.newContent,
								candidate(data.newContent.sourceId),
							),
							next: {
								kind: "finish",
								satisfied: true,
								reason: "説明できた",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const before = s.store.detail(s.job.id)!;
		const discovery = before.artifacts.at(-1)?.worldModelDiscovery;
		expect(discovery?.candidates[0].id).toMatch(/^wmc:[0-9a-f]{24}$/);
		s.store.close();
		const reopened = new Store(join(s.dir, "test.db"));
		try {
			const after = reopened.detail(s.job.id)!;
			expect(after.artifacts.at(-1)?.worldModelDiscovery).toEqual(discovery);
			expect(after.artifacts.map((item) => item.version)).toEqual(
				before.artifacts.map((item) => item.version),
			);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

test("W08 enabling discovery does not add a dedicated LLM call", async () => {
	async function count(version?: number) {
		const s = setup(version);
		const kinds: string[] = [];
		try {
			const e = new Engine(
				s.store,
				providers({
					async complete(kind, input) {
						kinds.push(kind);
						if (kind === "deliverable_episode")
							return { text: JSON.stringify(episode), usage: 100, audit: {} };
						const data = JSON.parse(input);
						if (!data.newContent)
							return {
								text: JSON.stringify({
									draft: null,
									next: {
										kind: "fetch",
										url: data.discoveries[0].url,
										purpose: "定義を確認",
									},
								}),
								usage: 100,
								audit: {},
							};
						return {
							text: JSON.stringify({
								draft: draftFrom(
									data.newContent,
									version === 1 ? emptyDiscovery() : undefined,
								),
								next: {
									kind: "finish",
									satisfied: true,
									reason: "説明できた",
								},
							}),
							usage: 100,
							audit: {},
						};
					},
				}),
				join(s.dir, "artifacts"),
			);
			await run(e, s.job.id);
			return kinds;
		} finally {
			s.close();
		}
	}
	expect(await count(1)).toEqual(await count());
});

test("W09 resuming an old job does not start discovery generation", async () => {
	const s = setup();
	try {
		const e = new Engine(
			s.store,
			providers({
				async complete(kind, input) {
					if (kind === "deliverable_episode")
						return { text: JSON.stringify(episode), usage: 100, audit: {} };
					const data = JSON.parse(input);
					expect(data.worldModelDiscoveryEnabled).not.toBe(true);
					if (!data.newContent)
						return {
							text: JSON.stringify({
								draft: null,
								next: {
									kind: "fetch",
									url: data.discoveries[0].url,
									purpose: "定義を確認",
								},
							}),
							usage: 100,
							audit: {},
						};
					return {
						text: JSON.stringify({
							draft: draftFrom(data.newContent, emptyDiscovery()),
							next: {
								kind: "finish",
								satisfied: true,
								reason: "説明できた",
							},
						}),
						usage: 100,
						audit: {},
					};
				},
			}),
			join(s.dir, "artifacts"),
		);
		await run(e, s.job.id);
		const detail = s.store.detail(s.job.id)!;
		expect(
			detail.events.some((event) =>
				JSON.stringify(event.data).includes("DISCOVERY_DISABLED"),
			),
		).toBe(true);
		expect(detail.artifacts.at(-1)?.worldModelDiscovery).toBeUndefined();
	} finally {
		s.close();
	}
});
