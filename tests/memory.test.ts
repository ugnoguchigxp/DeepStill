import { expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, mocks } from "../apps/worker/engine";
import { createApp } from "../apps/api/app";
import { Store } from "../packages/db";
import { createJobSchema, type JobDetail } from "../packages/contracts";
import { terminal } from "../packages/core";
import {
	drillMemory,
	memoryCandidates,
	validateMemory,
	memoryReviewPass,
} from "../packages/memory";
import { runReuseCase, summarizeReuse } from "../packages/memory/harness";
import type { LlmProvider } from "../packages/llm-provider";
async function fixture(llm: LlmProvider = mocks.llm, controlVersion = 2) {
	const dir = mkdtempSync(join(tmpdir(), "memory-test-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	const job = store.create(createJobSchema.parse({ topic: "LLMとWeb探索" }));
	job.config.researchControlVersion = controlVersion;
	store.saveJob(job);
	const engine = new Engine(store, () => ({ ...mocks, llm }), dir);
	for (let i = 0; i < 200 && !terminal(store.getJob(job.id)?.status ?? ""); i++)
		await engine.tick(job.id);
	const detail = store.detail(job.id) as JobDetail;
	return {
		dir,
		store,
		detail,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("memory is generated before evaluation and report, retained independent of paragraphs", async () => {
	const calls: string[] = [];
	const f = await fixture({
		async complete(k, i, a) {
			calls.push(k);
			return mocks.llm.complete(k, i, a);
		},
	});
	try {
		expect(f.detail.job.status).toBe("completed");
		expect(calls.indexOf("memory_knowledge")).toBeGreaterThan(
			calls.lastIndexOf("check_claims"),
		);
		expect(calls.indexOf("memory_review")).toBeLessThan(
			calls.indexOf("research_direction_review"),
		);
		expect(calls.lastIndexOf("memory_review")).toBeLessThan(
			calls.indexOf("synthesize"),
		);
		const artifact = f.detail.artifacts[0];
		const bundle = f.detail.memory?.find((m) => m.id === artifact.memoryId);
		expect(bundle).toBeDefined();
		if (!bundle) throw Error("missing");
		expect(bundle.knowledge).toHaveLength(0); // descriptive fixture must not manufacture rules
		expect(bundle.concepts.length).toBeGreaterThan(0);
		expect(validateMemory(bundle, f.detail)).toEqual([]);
		expect(
			memoryCandidates(bundle, { ...artifact, sections: [], claimIds: [] }),
		).toEqual(memoryCandidates(bundle, artifact));
		expect(
			JSON.parse(
				readFileSync(join(f.dir, f.detail.job.id, "1", "memory.json"), "utf8"),
			).id,
		).toBe(bundle.id);
		const app = createApp(f.store);
		const response = await app.request(
			`http://localhost/api/jobs/${f.detail.job.id}/memory?evidence=${bundle.evidence[0].evidenceId}`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).evidence.quote).toBe(
			bundle.evidence[0].quote,
		);
	} finally {
		f.close();
	}
});
test("locators and event identities reject false provenance and incomplete procedures", async () => {
	const f = await fixture();
	try {
		const bundle = structuredClone(f.detail.memory?.[0]);
		if (!bundle) throw Error("missing");
		const original = drillMemory(
			bundle,
			f.detail,
			bundle.evidence[0].evidenceId,
		);
		expect(original?.quote).toBe(bundle.evidence[0].quote);
		bundle.episodes[0].eventIds = [999999];
		expect(validateMemory(bundle, f.detail)).toContain(
			`${bundle.episodes[0].id}:unknown_event:999999`,
		);
		bundle.evidence[0].start++;
		expect(validateMemory(bundle, f.detail)).toContain("invalid_locator");
		expect(() =>
			drillMemory(bundle, f.detail, bundle.evidence[0].evidenceId),
		).toThrow("MEMORY_LOCATOR_STALE");
		bundle.knowledge = [
			{
				id: "k:incomplete",
				type: "procedure",
				polarity: "positive",
				title: "test",
				body: "test",
				appliesWhen: [],
				notApplicableWhen: [],
				steps: ["one"],
				verification: [],
				unknowns: [],
				claimIds: [f.detail.claims.find((c) => c.accepted)?.id ?? ""],
			},
		];
		expect(validateMemory(bundle, f.detail)).toContain(
			"k:incomplete:incomplete_procedure",
		);
	} finally {
		f.close();
	}
});
test("legacy repairable memory defects cause bounded regeneration, not extra web exploration", async () => {
	let reviews = 0;
	const f = await fixture(
		{
			async complete(k, i, a) {
				if (k === "memory_review" && reviews++ === 0)
					return {
						text: JSON.stringify({
							scores: { knowledge: 60, episode: 60, retrieval: 60 },
							defects: [
								{
									targetId: "bundle",
									requirementId: "general",
									reason: "Missing condition already in evidence",
									completionCriterion: "Restore condition",
									route: "revise_memory",
									critical: false,
									claimIds: [],
								},
							],
						}),
						usage: 100,
						audit: { fixture: true },
					};
				return mocks.llm.complete(k, i, a);
			},
		},
		1,
	);
	try {
		expect(f.detail.job.status).toBe("completed");
		expect(f.detail.research?.rounds).toHaveLength(1);
		expect(f.detail.memory?.some((m) => m.id.endsWith(":repair"))).toBe(true);
		expect(reviews).toBeGreaterThan(1);
	} finally {
		f.close();
	}
});
test("quality is strictly above 90 per axis, not an average or confidence", async () => {
	const f = await fixture();
	try {
		const bundle = f.detail.memory?.[0];
		if (!bundle?.review) throw Error("missing");
		bundle.review.scores = { knowledge: 100, episode: 100, retrieval: 90 };
		expect(memoryReviewPass(bundle)).toBe(false);
		expect(summarizeReuse([]).pass).toBe(false);
	} finally {
		f.close();
	}
});
test("reuse consumer never receives gold, judge must cover all checks and fabricated refs fail", async () => {
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const c = {
			id: "probe",
			axis: "retrieval" as const,
			split: "development" as const,
			question: "Recover detail",
			query: b.concepts[0].name,
			expected: ["SECRET_GOLD"],
			sourceIds: [b.evidence[0].evidenceId],
			critical: true,
		};
		const llm: LlmProvider = {
			async complete(k, input) {
				if (k === "memory_probe") {
					expect(input).not.toContain("SECRET_GOLD");
					return {
						text: JSON.stringify({
							answer: "Unknown",
							objectIds: ["invented"],
							evidenceIds: [],
							abstained: true,
						}),
						usage: 1,
						audit: {},
					};
				}
				expect(input).toContain("SECRET_GOLD");
				return {
					text: JSON.stringify({
						checks: [{ index: 0, score: 1, reason: "test" }],
						criticalFailure: false,
					}),
					usage: 1,
					audit: {},
				};
			},
		};
		const result = await runReuseCase(
			b,
			f.detail,
			c,
			llm,
			new AbortController().signal,
		);
		expect(result.invalidReferences).toBe(true);
		expect(result.criticalFailure).toBe(true);
	} finally {
		f.close();
	}
});

test("a report revision reuses memory candidates without hiding or duplicating them", async () => {
	const f = await fixture();
	try {
		const ids = f.detail.candidates.map((c) => c.id);
		f.store.queueMaintenance(f.detail.job.id, "edit");
		const engine = new Engine(f.store, () => mocks, f.dir);
		for (
			let i = 0;
			i < 100 && !terminal(f.store.getJob(f.detail.job.id)?.status ?? "");
			i++
		)
			await engine.tick(f.detail.job.id);
		const revised = f.store.detail(f.detail.job.id);
		expect(revised?.artifacts[0].version).toBe(2);
		expect(revised?.candidates.map((c) => c.id)).toEqual(ids);
		expect(revised?.artifacts[0].memoryId).toBe(f.detail.artifacts[0].memoryId);
	} finally {
		f.close();
	}
});

test("restart and user revision during memory generation never adopt a stale checkpoint", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-revision-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	try {
		const job = store.create(
			createJobSchema.parse({ topic: "LLM memory revision" }),
		);
		let changed = false;
		const calls: string[] = [];
		const provider = {
			...mocks,
			llm: {
				async complete(
					k: Parameters<LlmProvider["complete"]>[0],
					input: string,
					signal: AbortSignal,
				) {
					calls.push(k);
					if (k === "memory_episode" && !changed) {
						changed = true;
						store.addExploration(
							job.id,
							"memory-change",
							0,
							"Source conditions",
							"core",
						);
					}
					return mocks.llm.complete(k, input, signal);
				},
			},
		};
		for (
			let i = 0;
			i < 180 && !terminal(store.getJob(job.id)?.status ?? "");
			i++
		)
			await new Engine(store, () => provider, dir).tick(job.id);
		const d = store.detail(job.id);
		expect(terminal(d?.job.status ?? "")).toBe(true);
		expect(d?.memory?.length).toBeGreaterThan(0);
		expect(
			d?.memory
				?.filter((m) => m.status === "reviewed")
				.every((m) => m.revision === 1),
		).toBe(true);
		expect(
			d?.memory?.find((m) => m.id === d.artifacts[0].memoryId)?.revision,
		).toBe(1);
		expect(
			calls.filter((k) => k === "memory_knowledge").length,
		).toBeGreaterThan(0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("episode context excludes knowledge prose and exact IDs constrain provider output", async () => {
	const { memoryContext } = await import("../packages/memory");
	const { groundedSchema } = await import("../packages/llm-provider/codex");
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const input = memoryContext("memory_episode", f.detail, b);
		expect(input.claims).toEqual([]);
		expect(input.evidence).toEqual([]);
		expect("knowledge" in input.memory).toBe(false);
		const schema = JSON.stringify(
			groundedSchema("memory_episode", JSON.stringify(input)),
		);
		expect(schema).toContain('"maxItems":0');
		expect(schema).not.toContain('"not":{}');
		const review = JSON.stringify(
			groundedSchema(
				"memory_review",
				JSON.stringify(memoryContext("memory_review", f.detail, b)),
			),
		);
		expect(review).toContain('"enum":["bundle"');
		expect(review).toContain('"enum":["general","main"]');
	} finally {
		f.close();
	}
});

test("the judge receives valid consumer evidence beyond the gold subset", async () => {
	const f = await fixture();
	try {
		const b = f.detail.memory?.[0];
		if (!b) throw Error("missing");
		const object = b.concepts[0];
		const eid = b.evidence.find((e) =>
			object.claimIds.includes(e.claimId),
		)?.evidenceId;
		if (!eid) throw Error("missing");
		const other = b.evidence.find((e) => e.evidenceId !== eid)?.evidenceId;
		if (!other) throw Error("missing");
		const llm: LlmProvider = {
			async complete(k, input) {
				if (k === "memory_probe")
					return {
						text: JSON.stringify({
							answer: "Fixture source answer",
							objectIds: [object.id],
							evidenceIds: [eid],
							abstained: false,
						}),
						usage: 1,
						audit: {},
					};
				const data = JSON.parse(input);
				expect(
					data.goldSources.evidence.some((e: { id: string }) => e.id === eid),
				).toBe(false);
				expect(
					data.suppliedSources.evidence.some(
						(e: { evidenceId: string }) => e.evidenceId === eid,
					),
				).toBe(true);
				expect(data.referencesValidated).toBe(true);
				return {
					text: JSON.stringify({
						checks: [{ index: 0, score: 1, reason: "supported" }],
						criticalFailure: false,
						criticalReasons: [],
					}),
					usage: 1,
					audit: {},
				};
			},
		};
		const result = await runReuseCase(
			b,
			f.detail,
			{
				id: "alternate-source",
				axis: "retrieval",
				split: "development",
				query: object.name,
				question: "Read",
				expected: ["Fixture source answer"],
				sourceIds: [other],
				critical: true,
			},
			llm,
			new AbortController().signal,
		);
		expect(result.criticalFailure).toBe(false);
	} finally {
		f.close();
	}
});

test("v2 compares repair against exploration before regenerating memory", async () => {
	const calls: string[] = [];
	const f = await fixture({
		async complete(kind, input, signal) {
			calls.push(kind);
			if (kind === "memory_review")
				return {
					text: JSON.stringify({
						scores: { knowledge: 60, episode: 60, retrieval: 60 },
						defects: [
							{
								targetId: "bundle",
								requirementId: "general",
								reason: "Check a saved condition",
								completionCriterion: "Retain the original condition",
								route: "revise_memory",
								critical: false,
								claimIds: [],
							},
						],
					}),
					usage: 100,
					audit: { fixture: true },
				};
			return mocks.llm.complete(kind, input, signal);
		},
	});
	try {
		const direction = calls.indexOf("research_direction_review");
		expect(direction).toBeGreaterThan(0);
		expect(
			calls.slice(0, direction).filter((k) => k === "memory_review"),
		).toHaveLength(1);
		expect(f.detail.memory?.some((m) => m.id.endsWith(":repair"))).toBe(false);
	} finally {
		f.close();
	}
});

test("executed queries survive memory extraction and are searchable without an Episode paraphrase", async () => {
	const { emptyBundle, searchMemory, memoryObject } = await import(
		"../packages/memory"
	);
	const f = await fixture();
	try {
		const event = f.detail.events.find((e) => e.type === "query.selected");
		if (!event) throw Error("missing executed query");
		const memory = emptyBundle(f.detail);
		expect(memory.events.some((e) => e.id === event.id)).toBe(true);
		expect(
			searchMemory(memory, "LLMとWeb探索").some(
				(m) => m.id === `event:${event.id}`,
			),
		).toBe(true);
		const object = memoryObject(memory, `event:${event.id}`);
		expect(object && "record" in object ? object.record : null).toEqual(event);
		memory.events = structuredClone(memory.events);
		const savedEvent = memory.events.find((e) => e.id === event.id);
		if (!savedEvent) throw Error("missing saved query");
		savedEvent.data = { padding: "x".repeat(20000), query: "needle-query" };
		const match = searchMemory(memory, "needle-query")[0];
		expect(match.id).toBe(`event:${event.id}`);
		expect(match.text).toContain("needle-query");
		expect(match.text.length).toBeLessThanOrEqual(602);
		const full = memoryObject(memory, match.id);
		expect(full && "record" in full ? full.record.data : null).toEqual(
			savedEvent.data,
		);
		savedEvent.data = {
			query: "invented executed query",
		};
		expect(validateMemory(memory, f.detail)).toContain(
			`invalid_event_record:${event.id}`,
		);
	} finally {
		f.close();
	}
});

test("a rejected memory relation supplies its validation error to the bounded retry", async () => {
	let attempts = 0;
	let feedback: unknown;
	const f = await fixture({
		async complete(kind, input, signal) {
			const result = await mocks.llm.complete(kind, input, signal);
			if (kind === "memory_concepts") {
				attempts++;
				if (attempts === 1) {
					const value = JSON.parse(result.text);
					value.relations.push({
						from: "c:missing",
						to: value.concepts[0].id,
						type: "supports",
						conditions: [],
						claimIds: value.concepts[0].claimIds,
					});
					return { ...result, text: JSON.stringify(value) };
				}
				feedback = JSON.parse(input).priorValidationError;
			}
			return result;
		},
	});
	try {
		expect(attempts).toBe(2);
		expect(feedback).toContain("dangling_relation");
		expect(f.detail.job.status).toBe("completed");
		expect(f.detail.memory?.[0].structuralIssues).toEqual([]);
	} finally {
		f.close();
	}
});
