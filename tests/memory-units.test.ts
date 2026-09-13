import { expect, test } from "vitest";
import { combineReviews, updateGaps } from "../packages/memory/gaps";
import {
	changedMemoryClaims,
	selectMemoryDependencies,
} from "../packages/memory/delta";
import { memoryPartitions } from "../packages/memory/partition";
import {
	allocateMemoryIds,
	contextStillExport,
	emptyBundle,
	memoryContext,
	memoryObject,
	memoryObjectStatus,
	memoryStageHash,
	searchMemory,
	validateMemory,
} from "../packages/memory";
import type { MemoryReview } from "../packages/memory/schema";
import { makeClaim, makeDetail, makeJob, makeMemory } from "./helpers/fixtures";

const defect = (
	over: Partial<MemoryReview["defects"][number]> = {},
): MemoryReview["defects"][number] => ({
	targetId: "k:rule",
	requirementId: "main",
	reason: "missing verification",
	completionCriterion: "quote",
	route: "research",
	critical: true,
	claimIds: ["c1"],
	...over,
});

test("updateGaps opens route-specific operations and resolves rechecks", () => {
	const first = updateGaps(
		[],
		{
			scores: { knowledge: 40, episode: 40, retrieval: 40 },
			defects: [
				defect({ route: "revise_memory", completionCriterion: "revise" }),
				defect({
					targetId: "ep:run",
					route: "inspect_evidence",
					completionCriterion: "range",
				}),
				defect({
					targetId: "bundle",
					route: "approval_pending",
					completionCriterion: "approval",
				}),
				defect({
					route: "supplement",
					critical: false,
					completionCriterion: "optional",
				}),
			],
		},
		"memory:1",
	);
	expect(first.map((g) => g.operation).sort()).toEqual(
		["read_source", "revise_memory", "search", "wait_approval"].sort(),
	);
	const resolved = updateGaps(
		first,
		{
			scores: { knowledge: 90, episode: 90, retrieval: 90 },
			defects: [],
			rechecks: first.map((g) => ({
				id: g.id,
				resolved: true,
				reason: "closed",
			})),
		},
		"memory:2",
	);
	expect(resolved.every((g) => g.state === "resolved")).toBe(true);
	expect(() =>
		updateGaps(
			first,
			{
				scores: { knowledge: 1, episode: 1, retrieval: 1 },
				defects: [],
				rechecks: [{ id: "missing", resolved: true, reason: "x" }],
			},
			"memory:3",
		),
	).toThrow("UNKNOWN_GAP_RECHECK");
	expect(() =>
		updateGaps(
			first,
			{
				scores: { knowledge: 1, episode: 1, retrieval: 1 },
				defects: [
					defect({ route: "revise_memory", completionCriterion: "revise" }),
				],
				rechecks: [
					{
						id: first.find((g) => g.operation === "revise_memory")?.id ?? "",
						resolved: true,
						reason: "conflict",
					},
				],
			},
			"memory:4",
		),
	).toThrow("CONTRADICTORY_GAP_RECHECK");
});

test("combineReviews keeps unresolved rechecks and the worse scores", () => {
	const previous: MemoryReview = {
		scores: { knowledge: 40, episode: 90, retrieval: 70 },
		defects: [defect()],
		rechecks: [{ id: "gap-1", resolved: false, reason: "open" }],
	};
	const next: MemoryReview = {
		scores: { knowledge: 80, episode: 20, retrieval: 90 },
		defects: [defect({ reason: "still missing" })],
		rechecks: [{ id: "gap-1", resolved: true, reason: "attempt" }],
	};
	const combined = combineReviews(null, next);
	expect(combined).toBe(next);
	const merged = combineReviews(previous, next);
	expect(merged.scores).toEqual({ knowledge: 40, episode: 20, retrieval: 70 });
	expect(merged.rechecks?.[0].resolved).toBe(false);
});

test("changedMemoryClaims expands through related objects", () => {
	const detail = makeDetail();
	const previous = makeMemory();
	expect(changedMemoryClaims(detail, previous)).toBeNull();
	const current = makeMemory({
		evidence: previous.evidence.map((e) => ({ ...e, quote: `${e.quote}!` })),
	});
	expect(changedMemoryClaims(detail, current, previous)).toContain("c1");
	expect(changedMemoryClaims(detail, previous, previous)).toBeNull();
	const selected = selectMemoryDependencies(previous, ["c1"]);
	expect(selected.knowledge).toHaveLength(1);
	expect(selected.concepts).toHaveLength(1);
	expect(selectMemoryDependencies(previous, []).knowledge).toHaveLength(0);
});

test("memory search, status, export and partitions cover the remaining writers", () => {
	const detail = makeDetail();
	const bundle = makeMemory({
		review: {
			scores: { knowledge: 50, episode: 50, retrieval: 50 },
			defects: [defect({ critical: true })],
		},
		structuralIssues: ["duplicate_memory_id"],
	});
	expect(
		searchMemory(bundle, "snapshot integrity").some((x) => x.id === "k:rule"),
	).toBe(true);
	expect(searchMemory(bundle, "証拠本文", 2, "all").length).toBeGreaterThan(0);
	expect(memoryObject(bundle, "k:rule")?.id).toBe("k:rule");
	expect(memoryObject(bundle, "missing")).toBeNull();
	expect(memoryObjectStatus(bundle, "ev-1")).toBe("accepted");
	expect(memoryObjectStatus(bundle, "k:rule")).toBe("disputed");
	const accepted = makeMemory({
		status: "reviewed",
		review: {
			scores: { knowledge: 90, episode: 90, retrieval: 90 },
			defects: [defect({ critical: false, route: "supplement" })],
		},
		structuralIssues: [],
	});
	expect(memoryObjectStatus(accepted, "k:rule")).toBe("accepted");
	expect(
		memoryObjectStatus(makeMemory({ status: "draft", review: null }), "k:rule"),
	).toBe("draft");
	const exported = contextStillExport(bundle, detail);
	expect(exported.writePerformed).toBe(false);
	expect(exported.knowledge.length).toBeGreaterThan(0);
	expect(memoryContext("memory_episode", detail, bundle).memory).toBeDefined();
	expect(
		memoryContext("memory_knowledge", detail, bundle).memory,
	).toBeDefined();
	expect(memoryContext("memory_concepts", detail, bundle).memory).toBeDefined();
	expect(memoryContext("memory_review", detail, bundle).previous).toBeNull();
	expect(memoryStageHash("memory_episode", detail, bundle)).toHaveLength(64);
	expect(memoryStageHash("memory_knowledge", detail, bundle)).toHaveLength(64);
	expect(memoryStageHash("memory_concepts", detail, bundle)).toHaveLength(64);
	expect(memoryStageHash("memory_review", detail, bundle)).toHaveLength(64);
	const issues = validateMemory(bundle, detail);
	expect(issues.length).toBeGreaterThan(0);
	const empty = emptyBundle(detail);
	expect(empty.knowledge).toEqual([]);
	const parts = memoryPartitions(
		"memory_knowledge",
		detail,
		bundle,
		undefined,
		1_000_000,
	);
	expect(parts).toHaveLength(1);
	expect(() =>
		memoryPartitions("memory_knowledge", detail, bundle, undefined, 10),
	).toThrow("MEMORY_CONTEXT_MINIMUM_EXCEEDS_LIMIT");
	expect(
		memoryPartitions("memory_episode", detail, bundle, undefined, 1_000_000)
			.length,
	).toBeGreaterThan(0);
	expect(
		memoryPartitions("memory_review", detail, bundle, undefined, 1_000_000)
			.length,
	).toBeGreaterThan(0);
	const allocated = allocateMemoryIds(
		makeMemory({
			knowledge: [
				{
					...bundle.knowledge[0],
					id: "provisional",
				},
			],
		}),
		bundle,
	);
	expect(allocated.knowledge[0].id).toMatch(/^k:/);
});

test("gap rechecks stay open, reviews merge empty rechecks, and partitions split units", () => {
	const open = updateGaps(
		[],
		{
			scores: { knowledge: 10, episode: 10, retrieval: 10 },
			defects: [defect()],
		},
		"memory:1",
	);
	const kept = updateGaps(
		open,
		{
			scores: { knowledge: 10, episode: 10, retrieval: 10 },
			defects: [],
			rechecks: [{ id: open[0].id, resolved: false, reason: "still open" }],
		},
		"memory:2",
	);
	expect(kept[0].state).toBe("open");
	expect(
		combineReviews(
			{
				scores: { knowledge: 40, episode: 40, retrieval: 40 },
				defects: [defect()],
			},
			{
				scores: { knowledge: 30, episode: 50, retrieval: 20 },
				defects: [],
			},
		).rechecks,
	).toEqual([]);
	const detail = makeDetail({
		job: makeJob({ config: { researchControlVersion: 2 } }),
		claims: [
			makeClaim(),
			makeClaim({ id: "c2", evidenceIds: ["ev-1"], accepted: true }),
		],
		events: Array.from({ length: 8 }, (_, i) => ({
			id: i + 1,
			jobId: makeJob().id,
			type: "source.saved",
			data: { text: `payload ${"event ".repeat(120)}` },
			createdAt: 1,
		})),
	});
	const bundle = emptyBundle(detail);
	bundle.knowledge = [
		{
			id: "bad",
			type: "procedure",
			polarity: "negative",
			title: "Broken procedure",
			body: "incomplete",
			appliesWhen: [],
			notApplicableWhen: [],
			steps: ["one"],
			verification: [],
			unknowns: [],
			claimIds: ["missing"],
		},
	];
	bundle.episodes = [
		{
			id: "episode-1",
			title: "Bad episode",
			context: "x",
			intent: "x",
			observations: "observation ".repeat(80),
			decisions: ["d"],
			actionTaken: "a",
			outcome: "o",
			outcomeKind: "unknown",
			failedApproach: [],
			lesson: "l",
			triggers: ["t"],
			openLoops: [],
			eventIds: [99],
			claimIds: ["c1"],
		},
	];
	bundle.concepts = [
		{
			id: "concept-1",
			name: "c",
			aliases: [],
			description: "d",
			claimIds: ["c1"],
		},
	];
	bundle.relations = [
		{
			from: "missing",
			to: "also-missing",
			type: "supports",
			conditions: [],
			claimIds: ["missing"],
		},
	];
	bundle.review = {
		scores: { knowledge: 10, episode: 10, retrieval: 10 },
		defects: [
			{
				targetId: "unknown",
				requirementId: "nope",
				reason: "x",
				completionCriterion: "y",
				route: "research",
				critical: true,
				claimIds: ["missing"],
			},
		],
		rechecks: [{ id: "gap-missing", resolved: false, reason: "x" }],
	};
	const issues = validateMemory(bundle, detail);
	expect(issues.some((i) => i.includes("id_prefix"))).toBe(true);
	expect(issues).toContain("dangling_relation");
	bundle.episodes = detail.events.map((e) => ({
		id: `ep:${e.id}`,
		title: `Episode ${e.id} ${"title ".repeat(12)}`,
		context: "mock",
		intent: "cover partitions",
		observations: "observation ".repeat(160),
		decisions: ["keep"],
		actionTaken: "recorded",
		outcome: "ok",
		outcomeKind: "success",
		failedApproach: [],
		lesson: "split",
		triggers: ["research"],
		openLoops: [],
		eventIds: [e.id],
		claimIds: ["c1"],
	}));
	const episodeSize = Buffer.byteLength(
		JSON.stringify(memoryContext("memory_episode", detail, bundle)),
	);
	expect(
		memoryPartitions(
			"memory_episode",
			detail,
			bundle,
			undefined,
			Math.max(4000, Math.floor(episodeSize * 0.55)),
		).length,
	).toBeGreaterThan(1);
	const reviewSize = Buffer.byteLength(
		JSON.stringify(memoryContext("memory_review", detail, bundle)),
	);
	expect(
		memoryPartitions(
			"memory_review",
			detail,
			bundle,
			undefined,
			Math.max(4000, Math.floor(reviewSize * 0.55)),
		).length,
	).toBeGreaterThan(1);
	const linked = makeMemory({
		knowledge: [
			{
				...makeMemory().knowledge[0],
				claimIds: ["c1", "c2"],
			},
		],
		concepts: [
			{
				...makeMemory().concepts[0],
				claimIds: ["c1", "c2"],
			},
		],
	});
	const changed = makeMemory({
		knowledge: linked.knowledge,
		concepts: linked.concepts,
		evidence: [
			...linked.evidence,
			{
				...linked.evidence[0],
				claimId: "c2",
				quote: `${linked.evidence[0].quote} changed`,
			},
		],
	});
	expect(changedMemoryClaims(detail, changed, linked)).toEqual(
		expect.arrayContaining(["c1", "c2"]),
	);
});
