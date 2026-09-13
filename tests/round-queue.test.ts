import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, mocks } from "../apps/worker/engine";
import { createJobSchema } from "../packages/contracts";
import { terminal } from "../packages/core";
import { Store } from "../packages/db";

function must<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("EXPECTED_VALUE");
	return value;
}
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "round-test-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	// Preserve v1 regression fixtures; v2 control has dedicated direction tests.
	const create = store.create.bind(store);
	store.create = (input) => {
		const job = create(input);
		job.config.researchControlVersion = 1;
		job.config.researchFlow = "legacy";
		if (job.mode === "live")
			job.config.searchProvider = process.env.SEARCH_PROVIDER || "dataforseo";
		store.saveJob(job);
		return job;
	};
	return {
		dir,
		store,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
async function run(engine: Engine, id: string) {
	for (
		let i = 0;
		i < 150 && !terminal(engine.store.getJob(id)?.status ?? "");
		i++
	)
		await engine.tick(id);
}
test("round reads selected set before evaluating and does not suggest upfront", async () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		const calls: string[] = [];
		const engine = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async suggest() {
						throw new Error("UNEXPECTED_SUGGEST");
					},
				},
				llm: {
					async complete(k, i, a) {
						calls.push(k);
						return mocks.llm.complete(k, i, a);
					},
				},
			}),
			s.dir,
		);
		await run(engine, job.id);
		const d = must(s.store.detail(job.id));
		expect(d.job.status).toBe("completed");
		expect(d.research?.rounds).toHaveLength(1);
		expect(d.sources).toHaveLength(2);
		expect(calls.indexOf("evaluate_round")).toBeGreaterThan(
			calls.lastIndexOf("extract"),
		);
		expect(d.artifacts).toHaveLength(1);
		expect(d.research?.items.every((i) => i.status === "succeeded")).toBe(true);
	} finally {
		s.close();
	}
});
test("user priority and candidate updates are durable and revision protected", async () => {
	const s = setup();
	try {
		const j = s.store.create(createJobSchema.parse({ topic: "test topic" }));
		const engine = new Engine(s.store, () => mocks, s.dir);
		await engine.tick(j.id);
		const item = must(
			s.store.workItems(j.id).find((w) => w.status === "pending"),
		);
		expect(
			s.store.reprioritize(j.id, item.id, item.revision, 99).priority,
		).toBe(99);
		expect(() => s.store.reprioritize(j.id, item.id, item.revision, 1)).toThrow(
			"REVISION_CONFLICT",
		);
		const c = s.store.addExploration(j.id, "key", 0, "History", "trivia");
		expect(s.store.addExploration(j.id, "key", 0, "History", "trivia")).toEqual(
			c,
		);
		expect(() =>
			s.store.addExploration(j.id, "key", 1, "Different", "trivia"),
		).toThrow("REVISION_CONFLICT");
	} finally {
		s.close();
	}
});
test("global slot excludes another job and unknown operation blocks takeover", () => {
	const s = setup();
	try {
		const a = s.store.create(createJobSchema.parse({ topic: "first" }));
		const b = s.store.create(createJobSchema.parse({ topic: "second" }));
		const t = must(s.store.claim(30000, a.id));
		const u = must(s.store.claim(30000, b.id));
		expect(s.store.acquireSlot(t)).toBe(true);
		expect(s.store.acquireSlot(u)).toBe(false);
		s.store.markExternal(t, "external");
		s.store.sql.run("UPDATE execution_slot SET lease_until=0");
		expect(s.store.acquireSlot(u)).toBe(false);
		expect(s.store.slot().state).toBe("blocked");
		s.store.confirmExternalStopped(a.id, "Provider termination confirmed");
		expect(s.store.acquireSlot(u)).toBe(true);
	} finally {
		s.close();
	}
});
test("cancel and resume preserve selected set and completed operations", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "resume research" }),
		);
		const e = new Engine(s.store, () => mocks, s.dir);
		for (let i = 0; i < 5; i++) await e.tick(j.id);
		const round = s.store.research(j.id).rounds[0];
		s.store.cancel(j.id);
		s.store.resume(j.id);
		await run(e, j.id);
		expect(s.store.research(j.id).rounds[0].selected).toEqual(round.selected);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
	} finally {
		s.close();
	}
});
test("sufficient first round chooses useful trivia, completes second round before output", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		let evaluations = 0;
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						const base = await mocks.llm.complete(k, i, a);
						if (k !== "evaluate_round") return base;
						evaluations++;
						const data = JSON.parse(base.text);
						if (evaluations === 1) {
							data.opportunities = [
								{
									id: "history",
									question: "A concrete historical example",
									query: "historical original evidence",
									purpose: "trivia",
									requirementId: "main",
									reason: "Adds a verifiable origin example",
									claimIds: [],
									inScope: true,
									value: 2,
									novelty: 2,
									verifiability: 2,
									priority: 90,
								},
							];
							data.recommendation = "enrich";
						}
						return { ...base, text: JSON.stringify(data) };
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		const d = must(s.store.detail(j.id));
		expect(d.job.status).toBe("completed");
		expect(d.research?.rounds).toHaveLength(2);
		expect(d.research?.rounds[0].evaluation?.sufficient).toBe(true);
		expect(d.research?.rounds[1].purpose).toBe("trivia");
		expect(
			d.research?.items.find((i) => i.kind === "synthesize")?.createdAt,
		).toBeGreaterThanOrEqual(must(d.research).rounds[1].createdAt);
	} finally {
		s.close();
	}
});
test("tiny budget still exports an honest partial answer without provider work", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "tiny budget", budget: { tokens: 4096 } }),
		);
		const e = new Engine(s.store, () => mocks, s.dir);
		await run(e, j.id);
		expect(s.store.getJob(j.id)?.status).toBe("partial");
		expect(s.store.detail(j.id)?.artifacts).toHaveLength(1);
		expect(s.store.getJob(j.id)?.usage.tokens).toBeLessThanOrEqual(4096);
	} finally {
		s.close();
	}
});
test("unsuccessful fetch is reported, not treated as read evidence or endless wait", async () => {
	const s = setup();
	try {
		const j = s.store.create(createJobSchema.parse({ topic: "failed fetch" }));
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				crawler: {
					...mocks.crawler,
					async crawl() {
						throw new Error("HTTP_404");
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		const d = must(s.store.detail(j.id));
		expect(d.job.status).toBe("partial");
		expect(d.research?.rounds[0].evaluation?.sufficient).toBe(false);
		expect(d.claims).toHaveLength(0);
		expect(d.artifacts).toHaveLength(1);
	} finally {
		s.close();
	}
});
test("pending external search prevents another job from starting", async () => {
	const s = setup();
	try {
		const a = s.store.create(
			createJobSchema.parse({ topic: "pending search" }),
		);
		const b = s.store.create(createJobSchema.parse({ topic: "second search" }));
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async poll() {
						return { ready: false, hits: [], cost: 0 };
					},
				},
			}),
			s.dir,
		);
		await e.tick(a.id);
		await e.tick(a.id);
		await e.tick(a.id);
		expect(await e.tick(b.id)).toBe(false);
		expect(s.store.getJob(b.id)?.status).toBe("queued");
		await e.tick(a.id);
		expect(s.store.slot().operation_key).toMatch(/^pending:/);
	} finally {
		s.close();
	}
});
test("review maintenance is queued and processed without duplicating artifact versions", async () => {
	const s = setup();
	try {
		const j = s.store.create(createJobSchema.parse({ topic: "maintenance" }));
		const e = new Engine(s.store, () => mocks, s.dir);
		await run(e, j.id);
		const before = must(s.store.detail(j.id)).artifacts[0];
		const work = s.store.queueMaintenance(j.id, "review");
		expect(work.status).toBe("pending");
		await run(e, j.id);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
		expect(s.store.detail(j.id)?.artifacts[0].id).toBe(before.id);
		expect(s.store.detail(j.id)?.artifacts).toHaveLength(1);
	} finally {
		s.close();
	}
});
test("migration is additive and preserves legacy job data on repeated apply", () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "legacy persisted", engineVersion: 1 }),
		);
		const before = s.store.getJob(j.id);
		s.store.migrate();
		s.store.migrate();
		expect(s.store.getJob(j.id)).toEqual(before);
		expect(s.store.ready()).toBe(true);
	} finally {
		s.close();
	}
});
test("claim validation rejects an exact quote used for an out-of-scope claim", async () => {
	const s = setup();
	try {
		const j = s.store.create(createJobSchema.parse({ topic: "strict scope" }));
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						const value = await mocks.llm.complete(k, i, a);
						if (k !== "check_claims") return value;
						const data = JSON.parse(value.text);
						for (const d of data.decisions) {
							d.selected = false;
							d.reason = "Outside explicit conditions";
						}
						return { ...value, text: JSON.stringify(data) };
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(s.store.detail(j.id)?.claims.some((c) => c.accepted)).toBe(false);
		expect(s.store.getJob(j.id)?.status).toBe("partial");
	} finally {
		s.close();
	}
});
test("live-mode final review repairs once and uses the same serialized ledger", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({
				topic: "live adapter fixture",
				mode: "live",
				budget: { tokens: 1000000 },
			}),
		);
		let reviews = 0;
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						const input = JSON.parse(i);
						if (k === "synthesize" || k === "edit") {
							const claims = input.claims as { id: string; text: string }[];
							return {
								text: JSON.stringify({
									claimIds: claims.map((c) => c.id),
									sections: [
										{
											title: "Evidence",
											paragraphs: claims.map((c) => ({
												text: c.text,
												kind: "finding",
												claimIds: [c.id],
											})),
										},
									],
									limitations: [],
									openQuestions: [],
								}),
								usage: 120,
								audit: { fixture: true },
							};
						}
						if (k === "review") {
							reviews++;
							return {
								text: JSON.stringify({
									scores: {
										scope: 5,
										support: 5,
										depth: 5,
										narrative: reviews === 1 ? 3 : 5,
										readability: 5,
										knowledge: 5,
										episode: 5,
									},
									majorIssues: reviews === 1 ? ["Improve narrative"] : [],
									improvements: [],
									verdict: reviews === 1 ? "revise" : "pass",
								}),
								usage: 120,
								audit: { fixture: true },
							};
						}
						return mocks.llm.complete(k, i, a);
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
		expect(reviews).toBe(2);
		expect(
			s.store.workItems(j.id).filter((w) => w.kind === "edit"),
		).toHaveLength(1);
		expect(s.store.detail(j.id)?.artifacts[0].qualityState).toBe("reviewed");
		expect(s.store.detail(j.id)?.qualityReviews).toHaveLength(1);
	} finally {
		s.close();
	}
});
test("confirmed invalid LLM response retries once without poisoning the global slot", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "invalid response" }),
		);
		let n = 0;
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						if (k === "prepare_brief" && ++n === 1)
							return { text: "invalid", usage: 1, audit: {} };
						return mocks.llm.complete(k, i, a);
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
		expect(n).toBe(2);
		expect(s.store.slot().state).toBe("idle");
	} finally {
		s.close();
	}
});
test("next candidate added during evaluation causes evaluation of the new revision", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "concurrent candidate" }),
		);
		const candidateCounts: number[] = [];
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						if (k === "evaluate_round") {
							candidateCounts.push(JSON.parse(i).userCandidates.length);
							if (candidateCounts.length === 1)
								s.store.addExploration(
									j.id,
									"during",
									s.store.research(j.id).revision,
									"Explain a concrete example",
									"supplement",
								);
						}
						return mocks.llm.complete(k, i, a);
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(candidateCounts).toEqual([0, 1]);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
		expect(s.store.research(j.id).candidates[0].status).toBe("evaluated");
	} finally {
		s.close();
	}
});
test("source selection uses bounded batches, then compares the shortlist", async () => {
	const s = setup();
	try {
		const j = s.store.create(createJobSchema.parse({ topic: "many sources" }));
		const batchSizes: number[] = [];
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async poll() {
						return {
							ready: true,
							cost: 0,
							hits: Array.from({ length: 12 }, (_, i) => ({
								url: `https://fixture.example/source-${i}`,
								title: `Source ${i}`,
								snippet: "Relevant evidence",
								rank: i + 1,
							})),
						};
					},
				},
				llm: {
					async complete(k, i, a) {
						if (k === "select_sources")
							batchSizes.push(JSON.parse(i).candidates.length);
						return mocks.llm.complete(k, i, a);
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(batchSizes).toEqual([8, 4, 8]);
		expect(s.store.research(j.id).rounds[0].selected).toHaveLength(4);
	} finally {
		s.close();
	}
});

test("independent opportunity review rejects redundant exploration before another search", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		const calls: string[] = [];
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						calls.push(k);
						const base = await mocks.llm.complete(k, i, a);
						const data = JSON.parse(base.text);
						if (k === "evaluate_round")
							data.opportunities = [
								{
									id: "repeat",
									question: "Already known fact",
									query: "rephrased known fact",
									purpose: "supplement",
									requirementId: "main",
									reason: "Claims already explain this",
									claimIds: [],
									inScope: true,
									value: 2,
									novelty: 2,
									verifiability: 2,
									priority: 99,
								},
							];
						if (k === "review_opportunities") {
							expect(JSON.parse(i).knownClaims.length).toBeGreaterThan(0);
							data.decisions = [
								{
									id: "repeat",
									selected: false,
									reason: "Use existing facts in synthesis",
									priority: 0,
								},
							];
						}
						if (["select_sources", "synthesize"].includes(k))
							expect(JSON.parse(i).readerBrief.requirements).toHaveLength(1);
						return { ...base, text: JSON.stringify(data) };
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(s.store.research(j.id).rounds).toHaveLength(1);
		expect(s.store.getJob(j.id)?.usage.queries).toBe(1);
		expect(calls.indexOf("review_opportunities")).toBeGreaterThan(
			calls.indexOf("evaluate_round"),
		);
		expect(
			s.store
				.events(j.id)
				.some((x) => x.type === "round.opportunities_reviewed"),
		).toBe(true);
	} finally {
		s.close();
	}
});

test("search receives failed retrieval URLs from the previous round", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		let evaluations = 0;
		const histories: unknown[] = [];
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				search: {
					...mocks.search,
					async poll(id, signal, context) {
						histories.push(context?.failures);
						return mocks.search.poll(id, signal, context);
					},
				},
				llm: {
					async complete(k, i, a) {
						const base = await mocks.llm.complete(k, i, a);
						if (k !== "evaluate_round" || ++evaluations !== 1) return base;
						const data = JSON.parse(base.text);
						// A persisted failure from an earlier retrieval must reach the next search.
						const failed = s.store
							.workItems(j.id)
							.find((w) => w.kind === "fetch")!;
						s.store.saveWork({
							...failed,
							status: "failed",
							error: "fixture unavailable",
						});
						data.opportunities = [
							{
								id: "new",
								question: "New mechanism",
								query: "new independent mechanism evidence",
								purpose: "supplement",
								requirementId: "main",
								reason: "New evidence",
								claimIds: [],
								inScope: true,
								value: 2,
								novelty: 2,
								verifiability: 2,
								priority: 80,
							},
						];
						return { ...base, text: JSON.stringify(data) };
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(histories).toHaveLength(2);
		expect(histories[0]).toEqual([]);
		expect(histories[1]).toEqual([
			expect.objectContaining({ reason: "fixture unavailable" }),
		]);
	} finally {
		s.close();
	}
});

test("candidate changes during independent review invalidate the cached evaluation", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		let audits = 0;
		let sawNewCandidate = false;
		const e = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(k, i, a) {
						const input = JSON.parse(i);
						const base = await mocks.llm.complete(k, i, a);
						const data = JSON.parse(base.text);
						if (k === "evaluate_round") {
							if (input.userCandidates.length) sawNewCandidate = true;
							data.opportunities = [
								{
									id: "new",
									question: "New detail",
									query: "new detail primary evidence",
									purpose: "supplement",
									requirementId: "main",
									reason: "New fact",
									claimIds: [],
									inScope: true,
									value: 2,
									novelty: 2,
									verifiability: 2,
									priority: 80,
								},
							];
						}
						if (k === "review_opportunities") {
							if (++audits === 1)
								s.store.addExploration(
									j.id,
									"during-audit",
									s.store.research(j.id).revision,
									"A missing specific explanation",
									"supplement",
								);
							data.decisions = [
								{
									id: "new",
									selected: false,
									priority: 0,
									reason: "Known explanation",
								},
							];
						}
						return { ...base, text: JSON.stringify(data) };
					},
				},
			}),
			s.dir,
		);
		await run(e, j.id);
		expect(sawNewCandidate).toBe(true);
		expect(audits).toBe(2);
		expect(
			s.store.getJob(j.id)?.status,
			s.store.getJob(j.id)?.reason ?? "",
		).toBe("completed");
	} finally {
		s.close();
	}
});

test("queued revision carries the review for the current artifact", async () => {
	const s = setup();
	try {
		const j = s.store.create(
			createJobSchema.parse({ topic: "evidence research" }),
		);
		await run(new Engine(s.store, () => mocks, s.dir), j.id);
		const artifact = s.store.detail(j.id)!.artifacts[0];
		const feedback = {
			majorIssues: ["Explain the mechanism before the optional details"],
		};
		s.store.put(j.id, "quality_review", `v${artifact.version}`, {
			id: `v${artifact.version}`,
			version: artifact.version,
			review: feedback,
		});
		const item = s.store.queueMaintenance(j.id, "edit");
		expect(item.payload.feedback).toEqual(feedback);
	} finally {
		s.close();
	}
});
