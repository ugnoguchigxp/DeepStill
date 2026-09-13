import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, BudgetExceeded } from "../packages/db";
import { Engine, mocks } from "../apps/worker/engine";
import { createJobSchema } from "../packages/contracts";

test("direction and action selection consume their evaluation reserve while keeping finalization reserved", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-budget-"));
	const store = new Store(join(dir, "db"));
	store.migrate();
	try {
		const job = store.create(
			createJobSchema.parse({
				topic: "Budget boundary",
				budget: { tokens: 1000000, requests: 150 },
			}),
		);
		job.mode = "live";
		job.config.llmProvider = "codex";
		job.usage.tokens = 600000;
		store.saveJob(job);
		const task = store.claim(30000, job.id);
		if (!task) throw Error("missing task");
		store.acquireSlot(task);
		const engine = new Engine(store, () => mocks, dir);
		for (const kind of [
			"research_direction_review",
			"research_action_select",
		]) {
			await engine.operation(
				task,
				`round:test:${kind}:0:0`,
				{ tokens: 30000, requests: 1 },
				async () => ({ usage: 100 }),
			);
			expect(
				store.record<{ state: string }>(job.id, "budget_hold", "evaluation")
					?.state,
			).toBe("released");
			expect(
				store.record<{ state: string }>(job.id, "budget_hold", "final")?.state,
			).toBe("held");
		}
		await expect(
			engine.operation(
				task,
				"round:read:extract:0:0",
				{ tokens: 30000, requests: 1 },
				async () => ({ usage: 100 }),
			),
		).rejects.toBeInstanceOf(BudgetExceeded);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("action adoption rejects a search that cannot retain the same holds as execution", async () => {
	const dir = mkdtempSync(join(tmpdir(), "action-budget-"));
	const store = new Store(join(dir, "db"));
	store.migrate();
	try {
		const job = store.create(
			createJobSchema.parse({
				topic: "Budget adoption",
				budget: { tokens: 1000000, requests: 150 },
			}),
		);
		job.mode = "live";
		job.config.llmProvider = "codex";
		job.config.searchProvider = "codex";
		store.saveJob(job);
		const engine = new Engine(
			store,
			() => ({
				...mocks,
				llm: {
					async complete(kind, input, signal) {
						const data = JSON.parse(input);
						const result = await mocks.llm.complete(kind, input, signal);
						if (kind === "research_direction_review") {
							const value = JSON.parse(result.text);
							value.actions = [
								{
									id: "budget-search",
									purpose: "required",
									operation: "search",
									questionIds: [data.questions[0].id],
									gapIds: [],
									expectedDelta: "Independent comparison",
									reason: "New comparison evidence",
									inScope: true,
									novel: true,
									targetId: "",
									start: 0,
									end: 0,
									dependsOn: [],
									estimatedTokens: 16000,
									estimatedRequests: 7,
								},
							];
							return { ...result, text: JSON.stringify(value) };
						}
						if (kind === "research_action_select")
							return {
								...result,
								text: JSON.stringify({
									selectedId: data.actions[0].id,
									query: "independent comparison evidence",
									decision: "adopt",
									reasons: [
										{ id: data.actions[0].id, reason: "Independent source" },
									],
									reason: "Useful comparison",
								}),
							};
						return result;
					},
				},
			}),
			dir,
		);
		let injected = false;
		for (
			let tick = 0;
			tick < 200 && !store.all(job.id, "decision").length;
			tick++
		) {
			if (
				!injected &&
				store
					.workItems(job.id)
					.some(
						(w) =>
							w.kind === "evaluate" &&
							w.status === "pending" &&
							w.payload.direction,
					)
			) {
				const fresh = store.getJob(job.id)!;
				fresh.usage.tokens = 540207;
				store.saveJob(fresh);
				injected = true;
			}
			await engine.tick(job.id);
		}
		expect(injected).toBe(true);
		expect(store.all(job.id, "decision")[0]).toMatchObject({
			constraint: "budget_exhausted",
		});
		expect(
			store.workItems(job.id).filter((w) => w.kind === "search_submit"),
		).toHaveLength(1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
