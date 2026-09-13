import { createHash } from "node:crypto";
import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
import { Engine, mocks, type Providers } from "../apps/worker/engine";
import {
	createJobSchema,
	type JobDetail,
	type Snapshot,
} from "../packages/contracts";
import { terminal } from "../packages/core";
import {
	initialQuestions,
	updateQuestions,
	validateAction,
	type ActionCandidate,
} from "../packages/research/direction";
import { readSourceRange, sourceIndex } from "../packages/memory/source";
import {
	memoryStageHash,
	memoryInput,
	searchMemory,
	emptyBundle,
} from "../packages/memory";
import { retrieveQuestion } from "../packages/memory/retrieval";
const response = (value: unknown) => ({
	text: JSON.stringify(value),
	usage: 100,
	audit: { fixture: true },
});
async function fixture(
	change: (base: Providers) => Providers = (x) => x,
	live = false,
) {
	const dir = mkdtempSync(join(tmpdir(), "direction-test-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	const job = store.create(
		createJobSchema.parse({
			topic: "LLMとWeb探索",
			budget: {
				rounds: 3,
				depth: 3,
				tokens: 1000000,
				requests: 150,
				wallMs: 7200000,
			},
		}),
	);
	if (live) {
		job.mode = "live";
		job.config.searchRequestUsd = 0.1;
		store.saveJob(job);
	}
	const providers = change(mocks);
	const calls: string[] = [];
	const llm = providers.llm;
	const engine = new Engine(
		store,
		() => ({
			...providers,
			llm: {
				async complete(k, i, a) {
					calls.push(k);
					return llm.complete(k, i, a);
				},
			},
		}),
		dir,
	);
	for (let i = 0; i < 350 && !terminal(store.getJob(job.id)?.status ?? ""); i++)
		await engine.tick(job.id);
	return {
		store,
		dir,
		calls,
		detail: store.detail(job.id) as JobDetail,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
const action: ActionCandidate = {
	id: "independent",
	purpose: "required",
	operation: "search",
	questionIds: ["main"],
	gapIds: [],
	expectedDelta: "Independent source can answer unresolved question",
	reason: "Blocked source is not the question",
	inScope: true,
	novel: true,
	targetId: "",
	start: 0,
	end: 0,
	dependsOn: [],
	estimatedTokens: 16000,
	estimatedRequests: 7,
};
test("T1/T2 all sources withheld still evaluate independent action and retain zero-evidence episode", async () => {
	let directions = 0;
	const f = await fixture((base) => ({
		...base,
		crawler: {
			...base.crawler,
			async crawl() {
				throw Error("APPROVAL_PENDING");
			},
		},
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				if (k === "research_direction_review") {
					const result = JSON.parse((await base.llm.complete(k, i, a)).text);
					if (directions++ === 0) result.actions = [action];
					return response(result);
				}
				if (k === "research_action_select" && data.actions.length)
					return response({
						selectedId: data.actions[0].id,
						query: "independent evidence retrieval comparison",
						decision: "adopt",
						reasons: [{ id: data.actions[0].id, reason: "Independent source" }],
						reason: "Useful independent evidence",
					});
				return base.llm.complete(k, i, a);
			},
		},
	}));
	try {
		expect(f.detail.research?.rounds.length).toBe(2);
		expect(f.detail.claims).toHaveLength(0);
		expect(
			f.calls.filter(
				(k) => k === "memory_knowledge" || k === "memory_concepts",
			),
		).toHaveLength(0);
		expect(f.detail.artifacts[0].memoryId).toBeDefined();
		const memory = f.detail.memory?.find(
			(m) => m.id === f.detail.artifacts[0].memoryId,
		);
		expect(memory?.episodes.length).toBeGreaterThan(0);
		expect(f.calls.filter((k) => k === "memory_episode")).toHaveLength(1);
		expect(f.calls.filter((k) => k === "memory_review")).toHaveLength(1);
		expect(f.calls.indexOf("memory_episode")).toBeGreaterThan(
			f.calls.lastIndexOf("research_action_select"),
		);
		expect(memory?.events.some((e) => e.type === "query.selected")).toBe(true);
		expect(f.detail.candidates.some((c) => c.type === "episode")).toBe(true);
		expect(f.store.all(f.detail.job.id, "decision")).toHaveLength(2);
		expect(f.detail.job.usage.tokens).toBeLessThan(f.detail.job.budget.tokens);
	} finally {
		f.close();
	}
});
test("T3 inferred questions require a parent and cannot weaken explicit requirements", () => {
	const questions = initialQuestions(
		{
			requirements: [
				{
					id: "main",
					origin: "user",
					text: "Exact reconstruction",
					required: true,
					criterion: "same bytes",
				},
			],
		},
		0,
	);
	expect(() =>
		updateQuestions(questions, [{ ...questions[0], required: false }], [], 1),
	).toThrow("EXPLICIT_QUESTION_CHANGED");
	expect(() =>
		updateQuestions(
			questions,
			[{ ...questions[0], id: "new", origin: "inferred" }],
			[],
			1,
		),
	).toThrow("QUESTION_ORIGIN_INVALID");
	const changed = updateQuestions(
		questions,
		[
			{
				...questions[0],
				id: "provisional",
				origin: "inferred",
				parentIds: ["main"],
				reason: "Separate decoded samples and file bytes",
			},
		],
		[],
		1,
	);
	expect(changed.questions).toHaveLength(2);
	expect(changed.aliases.get("provisional")).toMatch(/^q:/);
});
test("T4 UTF-16 ranges recover Japanese newlines and convert actual UTF-8 bytes", () => {
	const source = {
		id: "s",
		hash: "h",
		text: "日本語\n😀条件\n第二の問い",
	} as Snapshot;
	source.hash = createHash("sha256").update(source.text).digest("hex");
	const range = readSourceRange(source, source.hash, { start: 4, end: 8 });
	expect(range.text).toBe("😀条件");
	expect(range.bytes).toEqual({ start: 10, end: 20 });
	expect(() =>
		readSourceRange(source, source.hash, { start: 5, end: 8 }),
	).toThrow("SPLIT_SURROGATE");
	expect(() =>
		readSourceRange(source, source.hash, { start: 4, end: 8 }, 100, [
			{ start: 6, end: 9 },
		]),
	).toThrow("OVERLAPPING_SOURCE_RANGE");
	expect(() =>
		readSourceRange(source, "changed", { start: 4, end: 8 }),
	).toThrow("SOURCE_HASH_CHANGED");
	expect(
		sourceIndex(source, 10)
			.ranges.map((r) => source.text.slice(r.start, r.end))
			.join(""),
	).toBe(source.text);
});
test("unchanged evidence skips writers while event changes invalidate only episode dependencies", async () => {
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const before = memoryStageHash("memory_knowledge", f.detail, b),
			ep = memoryStageHash("memory_episode", f.detail, b);
		f.detail.events.push({
			id: 999,
			jobId: f.detail.job.id,
			type: "research.decision",
			data: { reason: "new decision" },
			createdAt: Date.now(),
		});
		expect(memoryStageHash("memory_knowledge", f.detail, b)).toBe(before);
		expect(memoryStageHash("memory_episode", f.detail, b)).not.toBe(ep);
		expect(f.calls.filter((k) => k === "memory_knowledge")).toHaveLength(1);
	} finally {
		f.close();
	}
});
test("T6 evidence-only facts are searchable and consumer chooses query from question", async () => {
	const f = await fixture();
	try {
		const b = emptyBundle(f.detail);
		b.evidence = memoryInput(f.detail).evidence;
		const e = b.evidence[0];
		expect(
			searchMemory(b, e.quote.slice(0, 10)).some((x) => x.id === e.evidenceId),
		).toBe(true);
		let n = 0;
		const retrieved = await retrieveQuestion(
			b,
			f.detail,
			"条件を確認したい",
			{
				async complete(k, input) {
					expect(k).toBe("memory_retrieve");
					expect(input).not.toContain("SECRET_GOLD");
					return response(
						[
							{
								operation: "search",
								argument: e.quote.slice(0, 10),
								reason: "Find facts",
							},
							{
								operation: "object",
								argument: e.evidenceId,
								reason: "Read detail",
							},
							{
								operation: "evidence",
								argument: e.evidenceId,
								reason: "Read original",
							},
							{ operation: "answer", argument: "", reason: "Enough" },
						][n++],
					);
				},
			},
			new AbortController().signal,
		);
		expect(retrieved.objects).toHaveLength(1);
		expect(retrieved.evidence[0].quote).toBe(e.quote);
		expect(retrieved.history).toHaveLength(3);
	} finally {
		f.close();
	}
});
test("irrelevant extension and cosmetic repeated query are rejected independently of gaps", async () => {
	const f = await fixture();
	try {
		const q = initialQuestions(f.detail.memoryBrief!, 0);
		expect(
			validateAction({ ...action, inScope: false }, "other", f.detail, q, []),
		).toBe("no_information_delta");
		expect(
			validateAction(action, f.detail.queries[0].query, f.detail, q, []),
		).toBe("duplicate_query");
		expect(
			validateAction(
				{ ...action, gapIds: ["missing-gap"] },
				"other",
				f.detail,
				q,
				[],
			),
		).toBe("unknown_gap");
		expect(
			validateAction(
				{ ...action, operation: "revise_memory", targetId: "missing-memory" },
				"other",
				f.detail,
				q,
				[],
			),
		).toBe("unknown_memory_target");
		const currentMemory = f.detail.memory?.[0];
		if (!currentMemory) throw Error("missing saved memory");
		const episode = currentMemory.episodes[0];
		if (!episode) throw Error("missing saved episode");
		const withOldVersion = {
			...f.detail,
			memory: [
				currentMemory,
				{
					...currentMemory,
					id: "old-version",
					episodes: [{ ...episode, id: "ep:retired" }],
				},
			],
		};
		expect(
			validateAction(
				{ ...action, operation: "revise_memory", targetId: "ep:retired" },
				"",
				withOldVersion,
				q,
				[],
			),
		).toBe("unknown_memory_target");
		expect(
			validateAction(
				{ ...action, operation: "revise_memory", targetId: episode.id },
				"",
				f.detail,
				q,
				[],
			),
		).toBeNull();
	} finally {
		f.close();
	}
});

test("T5 final factual review reopens research and preserves both artifact and memory versions", async () => {
	let reviews = 0;
	const f = await fixture(
		(base) => ({
			...base,
			llm: {
				async complete(k, i, a) {
					if (k === "review")
						return response({
							researchNeeded: reviews++ === 0,
							scores: {
								scope: 4,
								support: 4,
								depth: 4,
								narrative: 4,
								readability: 4,
								knowledge: 4,
								episode: 4,
							},
							majorIssues:
								reviews === 1
									? ["A required factual distinction remains unsupported"]
									: [],
							improvements: [],
							verdict: reviews === 1 ? "revise" : "pass",
						});
					return base.llm.complete(k, i, a);
				},
			},
		}),
		true,
	);
	try {
		expect(f.detail.artifacts.length).toBe(2);
		expect(f.detail.artifacts[0].memoryId).not.toBe(
			f.detail.artifacts[1].memoryId,
		);
		expect(
			f.detail.artifacts.every((a) =>
				f.detail.memory?.some((m) => m.id === a.memoryId),
			),
		).toBe(true);
		expect(f.detail.research?.revision).toBe(1);
		expect(f.store.all(f.detail.job.id, "outcome").length).toBe(1);
	} finally {
		f.close();
	}
});
test("T3/T4 a newly evidenced distinction is added and assessed without duplicate fetches", async () => {
	let directions = 0;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				if (k === "research_direction_review") {
					const p = JSON.parse((await base.llm.complete(k, i, a)).text);
					if (directions++ === 0) {
						p.questionUpdates = [
							{
								...data.questions[0],
								id: "distinction",
								origin: "inferred",
								text: "Distinguish generated answers and verification",
								parentIds: [data.questions[0].id],
								reason: "Same source contains both conditions",
								claimIds: data.claims.map((c: { id: string }) => c.id),
								status: "supported",
								unknowns: [],
							},
						];
					}
					return response(p);
				}
				return base.llm.complete(k, i, a);
			},
		},
	}));
	try {
		expect(f.detail.research?.questions?.length).toBe(2);
		expect(
			f.detail.research?.questions?.every((q) => q.status === "supported"),
		).toBe(true);
		expect(f.detail.sources).toHaveLength(2);
		expect(
			f.detail.research?.items.filter((w) => w.kind === "fetch"),
		).toHaveLength(2);
	} finally {
		f.close();
	}
});
test("gap disappearance alone does not resolve a defect", async () => {
	const { updateGaps } = await import("../packages/memory/gaps");
	const review = {
		scores: { knowledge: 30, episode: 30, retrieval: 30 },
		defects: [
			{
				targetId: "bundle",
				requirementId: "main",
				reason: "condition missing",
				completionCriterion: "Recover exact condition",
				route: "research" as const,
				critical: true,
				claimIds: [],
			},
		],
	};
	const gaps = updateGaps([], review, "v1");
	expect(updateGaps(gaps, { ...review, defects: [] }, "v2")[0].state).toBe(
		"open",
	);
	expect(
		updateGaps(
			gaps,
			{
				...review,
				defects: [],
				rechecks: [
					{
						id: gaps[0].id,
						resolved: true,
						reason: "Condition recovered from original passage",
					},
				],
			},
			"v3",
		)[0].state,
	).toBe("resolved");
});

test("capacity partitions preserve every evidence unit and expose omitted IDs", async () => {
	const { memoryPartitions } = await import("../packages/memory/partition");
	const { makeClaim, makeDetail } = await import("./helpers/fixtures");
	const detail = makeDetail({
		claims: Array.from({ length: 8 }, (_, i) =>
			makeClaim({
				id: `claim:${i}`,
				text: `${i}: ${"source condition ".repeat(70)}`,
			}),
		),
	});
	const bundle = emptyBundle(detail);
	const parts = memoryPartitions(
		"memory_knowledge",
		detail,
		bundle,
		undefined,
		5000,
	);
	expect(parts.length).toBeGreaterThan(1);
	expect(new Set(parts.flatMap((p) => p.claims.map((c) => c.id))).size).toBe(8);
	for (const part of parts)
		expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(5000);
	bundle.knowledge = [
		{
			id: "k:joint",
			type: "rule",
			polarity: "positive",
			title: "Joint condition",
			body: "Both sources are required",
			appliesWhen: ["both"],
			notApplicableWhen: [],
			steps: [],
			verification: ["Read both"],
			unknowns: [],
			claimIds: ["claim:0", "claim:1"],
		},
	];
	const dependent = memoryPartitions(
		"memory_knowledge",
		detail,
		bundle,
		undefined,
		8000,
	);
	for (const part of dependent.filter((p) =>
		p.claims.some((c) => c.id === "claim:0" || c.id === "claim:1"),
	)) {
		expect(part.claims.map((c) => c.id)).toEqual(
			expect.arrayContaining(["claim:0", "claim:1"]),
		);
	}
	expect(() =>
		memoryPartitions("memory_knowledge", detail, bundle, undefined, 100),
	).toThrow("MEMORY_CONTEXT_MINIMUM_EXCEEDS_LIMIT");
});

test("new evidence expands only related memory dependencies", async () => {
	const { changedMemoryClaims, selectMemoryDependencies } = await import(
		"../packages/memory/delta"
	);
	const f = await fixture();
	try {
		const before = f.detail.memory?.[0];
		if (!before) throw Error("missing");
		const detail = structuredClone(f.detail),
			current = structuredClone(before);
		const claim = { ...detail.claims[0], id: "new-claim", accepted: true };
		detail.claims.push(claim);
		current.evidence.push({ ...current.evidence[0], claimId: claim.id });
		expect(changedMemoryClaims(detail, current, before)).toEqual([claim.id]);
		expect(selectMemoryDependencies(current, [claim.id]).concepts).toHaveLength(
			0,
		);
		expect(changedMemoryClaims(f.detail, before, before)).toBeNull();
	} finally {
		f.close();
	}
});

test("T6 API preserves version/state and follows evidence into bounded source ranges", async () => {
	const { createApp } = await import("../apps/api/app");
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const app = createApp(f.store);
		const evidence = b.evidence[0];
		const search = await app.request(
			`/api/memory/search?q=${encodeURIComponent(evidence.quote.slice(0, 12))}`,
		);
		expect(search.status).toBe(200);
		expect(
			(await search.json()).items.some(
				(x: { jobId: string; id: string }) =>
					x.jobId === f.detail.job.id && x.id === evidence.evidenceId,
			),
		).toBe(true);
		const root = `/api/jobs/${f.detail.job.id}/memory?version=${encodeURIComponent(b.id)}`;
		const index = await app.request(`${root}&snapshot=${evidence.snapshotId}`);
		expect(index.status).toBe(200);
		const source = await app.request(
			`${root}&snapshot=${evidence.snapshotId}&hash=${evidence.hash}&start=${evidence.start}&end=${evidence.end}`,
		);
		expect((await source.json()).text).toBe(evidence.quote);
		expect(
			(
				await app.request(
					`${root}&snapshot=${evidence.snapshotId}&hash=wrong&start=${evidence.start}&end=${evidence.end}`,
				)
			).status,
		).toBe(400);
		const old = structuredClone(b);
		old.id = "historical-memory";
		old.asOf = "2000-01-01T00:00:00.000Z";
		old.revision = 0;
		f.store.put(f.detail.job.id, "memory", old.id, old);
		const version = await app.request(
			`/api/jobs/${f.detail.job.id}/memory?version=historical-memory`,
		);
		expect((await version.json()).bundle.id).toBe(old.id);
	} finally {
		f.close();
	}
});

test("a fresh consumer can request arbitrary saved source ranges beyond quote context", async () => {
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const e = b.evidence[0];
		const source = f.detail.sources.find((s) => s.id === e.snapshotId);
		if (!source) throw Error("missing source");
		let step = 0;
		const result = await retrieveQuestion(
			b,
			f.detail,
			"Read the complete conditions",
			{
				async complete() {
					return response(
						[
							{
								operation: "search",
								argument: e.quote.slice(0, 10),
								reason: "Find relevant fact",
							},
							{
								operation: "object",
								argument: e.evidenceId,
								reason: "Find fixed source reference",
							},
							{
								operation: "source_index",
								argument: e.snapshotId,
								reason: "Find conditions elsewhere",
							},
							{
								operation: "source_range",
								argument: JSON.stringify({
									snapshotId: e.snapshotId,
									hash: e.hash,
									start: 0,
									end: source.text.length,
								}),
								reason: "Read the actual source",
							},
							{
								operation: "answer",
								argument: "",
								reason: "Original recovered",
							},
						][step++],
					);
				},
			},
			new AbortController().signal,
		);
		expect(result.ranges).toHaveLength(1);
		expect(result.ranges[0].text).toBe(source.text);
		expect(result.ranges[0].id).toMatch(/^range:/);
	} finally {
		f.close();
	}
});

test("multi-term research questions retrieve existing facts without requiring an exact sentence", async () => {
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const e = b.evidence[0];
		e.text = "SAFE agrees with human raters on 72% of individual facts";
		expect(
			searchMemory(b, "SAFE 72% 回答全体 正答率").some(
				(r) => r.id === e.evidenceId,
			),
		).toBe(true);
		b.episodes[0].title = "初回の探索と検索の記録";
		expect(
			searchMemory(b, "初回探索 検索語 目的").some(
				(r) => r.id === b.episodes[0].id,
			),
		).toBe(true);
	} finally {
		f.close();
	}
});

test("consumer schemas distinguish object IDs from claim IDs and bound recheck IDs", async () => {
	const { groundedSchema } = await import("../packages/llm-provider/codex");
	const answer = JSON.stringify(
		groundedSchema(
			"memory_probe",
			JSON.stringify({
				objects: [{ id: "object:1", claimId: "claim:1" }],
				evidence: [{ evidenceId: "evidence:1" }],
				ranges: [{ id: "range:1" }],
			}),
		),
	);
	expect(answer).toContain('"enum":["object:1"]');
	expect(answer).not.toContain("claim:1");
	expect(answer).toContain('"enum":["evidence:1","range:1"]');
	const review = JSON.stringify(
		groundedSchema(
			"memory_review",
			JSON.stringify({ claims: [], events: [], memory: {}, gaps: [] }),
		),
	);
	expect(review).toContain('"maxItems":0');
});

test("bounded Episode batches keep a recorded action and its outcome together", async () => {
	const { memoryPartitions } = await import("../packages/memory/partition");
	const f = await fixture();
	try {
		const detail = structuredClone(f.detail);
		const memory = structuredClone(detail.memory![0]);
		const episode = memory.episodes[0];
		const event = memory.events[0];
		if (!episode || !event) throw Error("missing recorded fixture");
		detail.events = Array.from({ length: 8 }, (_, i) => ({
			...event,
			id: 1000 + i,
			data: { observation: "recorded action and outcome ".repeat(120) },
		}));
		memory.events = detail.events;
		memory.episodes = [{ ...episode, claimIds: [], eventIds: [1000, 1001] }];
		const batches = memoryPartitions(
			"memory_episode",
			detail,
			memory,
			undefined,
			12000,
		);
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches.filter((b) =>
			b.events.some((e) => e.id === 1000 || e.id === 1001),
		)) {
			expect(batch.events.map((e) => e.id)).toEqual([1000, 1001]);
		}
		expect(
			new Set(batches.flatMap((b) => b.events.map((e) => e.id))).size,
		).toBe(8);
		for (const batch of batches)
			expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
				12000,
			);
	} finally {
		f.close();
	}
});

test("an empty first extraction continues to the unread part of the same snapshot", async () => {
	let extracts = 0;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(kind, input, signal) {
				const data = JSON.parse(input);
				if (kind === "source_range_select") {
					const middle = Math.floor(data.index.length / 2);
					return response(
						data.readRanges.length === 0
							? {
									start: 0,
									end: middle,
									done: false,
									reason: "Read introduction",
								}
							: data.readRanges.length === 1
								? {
										start: middle,
										end: data.index.length,
										done: false,
										reason: "Read remaining original evidence",
									}
								: {
										start: 0,
										end: 0,
										done: true,
										reason: "All original ranges read",
									},
					);
				}
				if (kind === "extract" && extracts++ === 0)
					return response({ claims: [], concepts: [] });
				return base.llm.complete(kind, input, signal);
			},
		},
	}));
	try {
		const reads = f.detail.research!.items.filter(
			(w) =>
				w.kind === "read" &&
				w.status === "succeeded" &&
				(w.result as { passages?: unknown[] })?.passages?.length,
		);
		const first = reads.find(
			(w) => !(w.result as { claimIds: string[] }).claimIds.length,
		);
		if (!first) throw Error("missing empty read");
		const sourceId = (first.result as { sourceId: string }).sourceId;
		expect(
			reads.filter(
				(w) => (w.result as { sourceId: string }).sourceId === sourceId,
			),
		).toHaveLength(2);
		expect(
			f.detail.research!.items.filter(
				(w) =>
					w.kind === "fetch" &&
					(w.result as { sourceId?: string })?.sourceId === sourceId,
			),
		).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("action selection cannot adopt a code-rejected candidate", async () => {
	const { groundedSchema } = await import("../packages/llm-provider/codex");
	const schema = groundedSchema(
		"research_action_select",
		JSON.stringify({ admissibleActionIds: ["action:read-unread"] }),
	) as unknown as { properties: { selectedId: { enum: string[] } } };
	expect(schema.properties.selectedId.enum).toEqual(["", "action:read-unread"]);
	expect(schema.properties.selectedId.enum).not.toContain(
		"action:already-read",
	);
});

test("independent fulfillment rejects invented support and omitted required questions", async () => {
	const { validateFulfillment } = await import(
		"../packages/research/fulfillment"
	);
	const input = {
		originalRequest: "Explain the boundary",
		questions: [
			{
				id: "q1",
				text: "Explain the boundary",
				required: true,
				criterion: "Supported boundary",
			},
			{
				id: "q2",
				text: "Optional example",
				required: false,
				criterion: "Supported example",
			},
		],
		claims: [
			{
				id: "c1",
				text: "A scoped boundary",
				kind: "NEW" as const,
				relatedClaimIds: [],
				evidence: [
					{
						claimId: "c1",
						text: "A scoped boundary",
						kind: "NEW" as const,
						evidenceId: "e1",
						snapshotId: "s1",
						hash: "h1",
						url: "https://fixture.example/",
						start: 0,
						end: 17,
						unit: "utf16" as const,
						quote: "A scoped boundary",
					},
				],
			},
		],
	};
	const valid = {
		coverage: [
			{
				questionId: "q1",
				supported: true,
				claimIds: ["c1"],
				reason: "Supported boundary",
			},
			{
				questionId: "q2",
				supported: false,
				claimIds: [],
				reason: "Optional example not observed",
			},
		],
		criticalIssues: [],
		conclusion: "fulfilled",
	};
	const { groundedSchema } = await import("../packages/llm-provider/codex");
	expect(
		groundedSchema("research_fulfillment", JSON.stringify(input)),
	).toMatchObject({
		properties: {
			coverage: {
				minItems: 2,
				maxItems: 2,
				items: {
					properties: {
						questionId: { enum: ["q1", "q2"] },
						claimIds: { items: { enum: ["c1"] } },
					},
				},
			},
		},
	});
	expect(validateFulfillment(valid, input).conclusion).toBe("fulfilled");
	expect(() =>
		validateFulfillment(
			{ ...valid, coverage: valid.coverage.slice(0, 1) },
			input,
		),
	).toThrow("FULFILLMENT_QUESTION_COVERAGE");
	expect(() =>
		validateFulfillment(
			{
				...valid,
				coverage: [
					{ ...valid.coverage[0], claimIds: ["invented"] },
					valid.coverage[1],
				],
			},
			input,
		),
	).toThrow("FULFILLMENT_UNSUPPORTED_REFERENCE");
	expect(() =>
		validateFulfillment(
			{ ...valid, criticalIssues: ["Unjustified generalization"] },
			input,
		),
	).toThrow("FULFILLMENT_CONCLUSION_MISMATCH");
});

test("an unattempted discovery can be fetched without another search", async () => {
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(kind, input, signal) {
				const data = JSON.parse(input);
				if (kind === "select_sources")
					return response({
						decisions: data.candidates.map((c: { id: string }) => ({
							id: c.id,
							selected: false,
							priority: 0,
							reason: "Compare individually after the first selection",
						})),
					});
				if (
					kind === "research_direction_review" &&
					!data.claims.length &&
					data.unattemptedDiscoveries.length
				) {
					const original = JSON.parse(
						(await base.llm.complete(kind, input, signal)).text,
					);
					return response({
						...original,
						actions: [
							{
								...action,
								operation: "fetch_source",
								targetId: data.unattemptedDiscoveries[0].id,
								questionIds: [data.questions[0].id],
								reason:
									"Existing independent candidate can answer the question",
							},
						],
					});
				}
				if (kind === "research_action_select" && data.actions.length)
					return response({
						selectedId: data.actions[0].id,
						query: "",
						decision: "adopt",
						reasons: data.actions.map((a: { id: string }) => ({
							id: a.id,
							reason: "Acquire existing discovery",
						})),
						reason: "No new search needed",
					});
				return base.llm.complete(kind, input, signal);
			},
		},
	}));
	try {
		expect(f.detail.job.status).toBe("completed");
		expect(f.detail.queries).toHaveLength(1);
		expect(f.detail.sources).toHaveLength(1);
		expect(f.detail.claims.some((c) => c.accepted)).toBe(true);
		expect(
			f.detail.research?.items.some(
				(w) => w.kind === "fetch" && w.payload.actionId,
			),
		).toBe(true);
	} finally {
		f.close();
	}
});

test("contradictions block overall completion even when every coverage row is sufficient", async () => {
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				const result = await base.llm.complete(k, i, a);
				if (k === "research_direction_review") {
					const p = JSON.parse(result.text);
					p.evaluation.sufficient = false;
					p.evaluation.contradictions = [
						"Independent sources disagree under the same conditions",
					];
					return response(p);
				}
				if (k === "research_action_select") {
					expect(data.completionAllowed).toBe(false);
					return response({
						selectedId: "",
						query: "",
						decision: "unmet",
						reasons: [],
						reason: "Unresolved contradiction",
					});
				}
				return result;
			},
		},
	}));
	try {
		expect(f.detail.research?.sufficient).toBe(false);
		expect(f.detail.job.status).not.toBe("completed");
	} finally {
		f.close();
	}
});

test("a revised inferred criterion is reopened and assessed in a separate call before completion", async () => {
	let reviews = 0;
	let observedFresh = false;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				const result = await base.llm.complete(k, i, a);
				if (k === "prepare_brief") {
					const p = JSON.parse(result.text);
					p.requirements[0].origin = "inferred";
					p.requirements[0].originQuote = "";
					return response(p);
				}
				if (k === "research_direction_review") {
					const p = JSON.parse(result.text);
					if (reviews++ === 0)
						p.questionUpdates = [
							{
								...data.questions[0],
								criterion: "Compare exact applicability conditions",
								reason: "The original topic needs applicability clarified",
							},
						];
					else {
						expect(data.questions[0].status).toBe("open");
						expect(data.questions[0].claimIds).toEqual([]);
						expect(data.questions[0].criterion).toBe(
							"Compare exact applicability conditions",
						);
						observedFresh = true;
					}
					return response(p);
				}
				return result;
			},
		},
	}));
	try {
		expect(observedFresh).toBe(true);
		expect(reviews).toBe(2);
		expect(f.detail.research?.sufficient).toBe(true);
		expect(f.detail.queries).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("an unaffordable candidate is excluded before selection while an affordable search proceeds", async () => {
	let reviews = 0;
	let checked = false;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				const result = await base.llm.complete(k, i, a);
				if (k === "research_direction_review") {
					const p = JSON.parse(result.text);
					if (reviews++ === 0)
						p.actions = [
							{ ...action, id: "expensive", estimatedTokens: 2000000 },
							{
								...action,
								id: "affordable",
								expectedDelta: "Independent counterevidence",
							},
						];
					return response(p);
				}
				if (k === "research_action_select" && data.actions.length) {
					expect(data.candidateChecks[0].constraint).toBe("budget_exhausted");
					expect(data.admissibleActionIds).toEqual([data.actions[1].id]);
					checked = true;
					return response({
						selectedId: data.actions[1].id,
						query: "independent contrary evidence conditions",
						decision: "adopt",
						reasons: data.actions.map((x: { id: string }) => ({
							id: x.id,
							reason: "Respect execution budget",
						})),
						reason: "Affordable independent evidence",
					});
				}
				return result;
			},
		},
	}));
	try {
		expect(checked).toBe(true);
		expect(f.detail.queries).toHaveLength(2);
	} finally {
		f.close();
	}
});

test("selection veto is retained even when the direction reviewer reported sufficient coverage", async () => {
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				if (k === "research_action_select")
					return response({
						selectedId: "",
						query: "",
						decision: "unmet",
						reasons: [],
						reason: "The comparison still lacks compatible conditions",
					});
				return base.llm.complete(k, i, a);
			},
		},
	}));
	try {
		expect(f.detail.research?.sufficient).toBe(false);
		expect(f.detail.job.status).not.toBe("completed");
		expect(f.detail.job.reason).toBe("no_valuable_candidate");
	} finally {
		f.close();
	}
});

test("a rejected query reselects a remaining candidate without repeating the search", async () => {
	let reviews = 0;
	let selections = 0;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				const result = await base.llm.complete(k, i, a);
				if (k === "research_direction_review") {
					const p = JSON.parse(result.text);
					if (reviews++ === 0)
						p.actions = [
							{ ...action, id: "repeat" },
							{
								...action,
								id: "new",
								expectedDelta: "New independent evidence",
							},
						];
					return response(p);
				}
				if (k === "research_action_select" && data.actions.length) {
					const first = selections++ === 0;
					if (!first) {
						expect(data.candidateChecks[0].constraint).toBe(
							"selection_rejected",
						);
						expect(data.admissibleActionIds).toEqual([data.actions[1].id]);
					}
					return response({
						selectedId: data.actions[first ? 0 : 1].id,
						query: first
							? data.previousQueries[0]
							: "independent additional evidence conditions",
						decision: "adopt",
						reasons: data.actions.map((x: { id: string }) => ({
							id: x.id,
							reason: "Test alternative recovery",
						})),
						reason: "Independent alternative",
					});
				}
				return result;
			},
		},
	}));
	try {
		expect(selections).toBe(2);
		expect(f.detail.queries).toHaveLength(2);
		expect(
			f.detail.events.some((e) => e.type === "research.selection_rejected"),
		).toBe(true);
	} finally {
		f.close();
	}
});

test("brief origin failure is repaired with exact feedback before search begins", async () => {
	let attempts = 0;
	let repaired = false;
	const f = await fixture((base) => ({
		...base,
		llm: {
			async complete(k, i, a) {
				const data = JSON.parse(i);
				const result = await base.llm.complete(k, i, a);
				if (k === "prepare_brief") {
					const p = JSON.parse(result.text);
					if (attempts++ === 0) {
						p.requirements[0].origin = "literal inferred";
						return response(p);
					}
					expect(data.priorValidationError).toContain("origin");
					expect(data.previousOutput).toContain("literal inferred");
					p.requirements[0].origin = "inferred";
					p.requirements[0].originQuote = "";
					repaired = true;
					return response(p);
				}
				return result;
			},
		},
	}));
	try {
		expect(repaired).toBe(true);
		expect(attempts).toBe(2);
		expect(f.detail.queries.length).toBeGreaterThan(0);
		expect(f.detail.memoryBrief?.requirements[0].origin).toBe("inferred");
	} finally {
		f.close();
	}
});
