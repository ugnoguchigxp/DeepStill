import { createHash } from "node:crypto";
import type {
	Artifact,
	Claim,
	Evidence,
	Job,
	JobDetail,
	Snapshot,
} from "../../packages/contracts";
import type { MemoryBundle } from "../../packages/memory/schema";
import type { ResearchState, WorkItem } from "../../packages/research/rounds";

export const SAMPLE_TEXT =
	"Immutable snapshots preserve the exact text used as evidence. A claim must reference a passage in an external source.";
export const SAMPLE_QUOTE =
	"Immutable snapshots preserve the exact text used as evidence.";

export const budget = {
	rounds: 6,
	queries: 50,
	urls: 100,
	documents: 20,
	tokens: 100000,
	requests: 200,
	costUsd: 5,
	depth: 5,
	wallMs: 7200000,
};
export const usage = {
	queries: 1,
	urls: 1,
	documents: 1,
	tokens: 100,
	requests: 2,
	costUsd: 0.01,
};

export function makeJob(over: Partial<Job> = {}): Job {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		topic: "LLMとWeb探索",
		mode: "mock",
		strategy: "balanced",
		seed: "manual",
		status: "completed",
		reason: null,
		createdAt: 1_700_000_000_000,
		startedAt: 1_700_000_000_000,
		deadline: 1_700_007_200_000,
		updatedAt: 1_700_000_000_000,
		...over,
		budget: { ...budget, ...over.budget },
		usage: { ...usage, ...over.usage },
		config: {
			engineVersion: 2,
			llmProvider: "compatible",
			llmModel: "test",
			...over.config,
		},
	};
}

export function makeSource(over: Partial<Snapshot> = {}): Snapshot {
	const text = over.text ?? SAMPLE_TEXT;
	return {
		id: "src-1",
		author: null,
		publishedAt: null,
		url: "https://fixture.example/research",
		finalUrl: "https://fixture.example/research",
		title: "Research fixture",
		fetchedAt: "2026-09-12T00:00:00.000Z",
		fetchMethod: "fixture",
		truncated: false,
		security: { trust: "untrusted", decision: "allow" },
		extractor: "fixture-v1",
		fixture: true,
		...over,
		text,
		hash: over.hash ?? createHash("sha256").update(text).digest("hex"),
	};
}

export function makeEvidence(over: Partial<Evidence> = {}): Evidence {
	const start = SAMPLE_TEXT.indexOf(SAMPLE_QUOTE);
	return {
		id: "ev-1",
		snapshotId: "src-1",
		quote: SAMPLE_QUOTE,
		start,
		end: start + SAMPLE_QUOTE.length,
		context: SAMPLE_TEXT,
		...over,
	};
}

export function makeClaim(over: Partial<Claim> = {}): Claim {
	return {
		id: "c1",
		text: SAMPLE_QUOTE,
		evidenceIds: ["ev-1"],
		confidence: 0.9,
		kind: "NEW",
		accepted: true,
		reason: "quoted",
		relatedClaimIds: [],
		...over,
	};
}

export function makeArtifact(over: Partial<Artifact> = {}): Artifact {
	return {
		id: "art-1",
		version: 1,
		title: "Research report",
		body: SAMPLE_QUOTE,
		claimIds: ["c1"],
		generatedAt: "2026-09-12T00:00:00.000Z",
		fixture: true,
		qualityState: "reviewed",
		limitations: ["範囲はfixtureに限る"],
		openQuestions: ["実資料ではどうか"],
		sections: [
			{
				title: "根拠",
				paragraphs: [
					{
						text: SAMPLE_QUOTE,
						kind: "finding",
						claimIds: ["c1"],
					},
				],
			},
		],
		...over,
	};
}

export function makeWorkItem(over: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "work-1",
		jobId: makeJob().id,
		roundId: "r1",
		kind: "read",
		status: "running",
		priority: 10,
		reason: "read source",
		revision: 1,
		nextAt: 0,
		dependsOn: [],
		payload: { query: "evidence snapshots", title: "Research fixture" },
		createdAt: Date.now(),
		...over,
	};
}

export function makeResearch(over: Partial<ResearchState> = {}): ResearchState {
	return {
		version: 2,
		revision: 1,
		rounds: [
			{
				id: "r1",
				number: 1,
				purpose: "core",
				state: "evaluating",
				queries: ["evidence snapshots"],
				selected: ["https://fixture.example/research"],
				candidates: [],
				reason: "",
				revision: 1,
				createdAt: Date.now(),
				evaluation: {
					coverage: [
						{
							requirementId: "main",
							status: "partial",
							reason: "一部不足",
							claimIds: ["c1"],
						},
					],
					sufficient: false,
					materialGaps: ["詳細"],
					contradictions: [],
					answerOutline: [],
					opportunities: [],
					recommendation: "fill_gap",
					reason: "中心の説明が不足",
				},
			},
		],
		items: [
			makeWorkItem(),
			makeWorkItem({
				id: "work-2",
				kind: "search_submit",
				status: "pending",
				payload: { query: "next query" },
			}),
		],
		sufficient: false,
		reason: "no_valuable_candidate",
		candidates: [],
		holds: [
			{
				id: "final",
				tokens: 12000,
				requests: 1,
				state: "held",
				reason: "回答統合",
			},
		],
		questions: [
			{
				id: "main",
				origin: "user",
				text: "Explain",
				use: "Explain",
				required: true,
				criterion: "Evidence",
				parentIds: [],
				reason: "user",
				claimIds: ["c1"],
				unknowns: ["詳細"],
				status: "open",
				revision: 1,
			},
		],
		slot: { state: "idle", jobId: null, operationKey: null },
		...over,
	};
}

export function makeMemory(over: Partial<MemoryBundle> = {}): MemoryBundle {
	const evidence = makeEvidence();
	const source = makeSource();
	return {
		id: "memory:v1",
		schemaVersion: "memory-v1",
		inputHash: "hash",
		revision: 1,
		asOf: "2026-09-12T00:00:00.000Z",
		jobId: makeJob().id,
		topic: "LLMとWeb探索",
		supersedes: null,
		events: [],
		knowledge: [
			{
				id: "k:rule",
				type: "rule",
				polarity: "positive",
				title: "Snapshot integrity",
				body: SAMPLE_QUOTE,
				appliesWhen: ["quoting sources"],
				notApplicableWhen: [],
				steps: [],
				verification: ["quote matches snapshot"],
				unknowns: [],
				claimIds: ["c1"],
			},
		],
		episodes: [
			{
				id: "ep:run",
				title: "Fixture run",
				context: "mock research",
				intent: "verify quotes",
				observations: SAMPLE_QUOTE,
				decisions: ["accept"],
				actionTaken: "quoted",
				outcome: "verified",
				outcomeKind: "success",
				failedApproach: [],
				lesson: "keep original offsets",
				triggers: ["research"],
				openLoops: [],
				eventIds: [1],
				claimIds: ["c1"],
			},
		],
		concepts: [
			{
				id: "c:snapshot",
				name: "snapshot",
				aliases: ["証拠本文"],
				description: SAMPLE_QUOTE,
				claimIds: ["c1"],
			},
		],
		relations: [
			{
				from: "k:rule",
				to: "c:snapshot",
				type: "supports",
				conditions: [],
				claimIds: ["c1"],
			},
		],
		evidence: [
			{
				claimId: "c1",
				text: SAMPLE_QUOTE,
				kind: "NEW",
				evidenceId: evidence.id,
				snapshotId: source.id,
				hash: source.hash,
				url: source.finalUrl,
				start: evidence.start,
				end: evidence.end,
				unit: "utf16",
				quote: evidence.quote,
			},
		],
		review: {
			scores: { knowledge: 90, episode: 88, retrieval: 85 },
			defects: [],
		},
		status: "reviewed",
		structuralIssues: [],
		...over,
	};
}

export function makeDetail(over: Partial<JobDetail> = {}): JobDetail {
	const job = over.job ?? makeJob();
	const source = makeSource();
	const evidence = makeEvidence();
	const claim = makeClaim();
	return {
		job,
		queries: [
			{
				id: "q1",
				query: "evidence snapshots",
				depth: 0,
				score: 100,
				reason: "seed",
				status: "searched",
				known: "explore",
			},
		],
		edges: [{ from: "q1", to: "q1", source: "seed" }],
		sources: [source],
		evidence: [evidence],
		claims: [claim],
		artifacts: [makeArtifact()],
		candidates: [
			{
				id: "cand-1",
				type: "knowledge",
				text: SAMPLE_QUOTE,
				claimIds: ["c1"],
				adoption: "accepted",
				artifactVersion: 1,
			},
		],
		events: [
			{
				id: 1,
				jobId: job.id,
				type: "job.started",
				data: {},
				createdAt: job.createdAt,
			},
			{
				id: 2,
				jobId: job.id,
				type: "budget.reserved",
				data: { tokens: 10 },
				createdAt: job.createdAt,
			},
		],
		operations: [],
		research: makeResearch(),
		memory: [makeMemory()],
		qualityReviews: [
			{
				version: 1,
				review: {
					verdict: "pass",
					scores: { scope: 5 },
				},
			},
		],
		...over,
	};
}
