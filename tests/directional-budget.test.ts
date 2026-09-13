import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Engine } from "../apps/worker/engine";
import { budgetSchema, createJobSchema } from "../packages/contracts";
import { BudgetExceeded, Store } from "../packages/db";
import {
	splitTokenReservation,
	tokenBudgetFits,
} from "../packages/research/budget";

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "directional-budget-"));
	const store = new Store(join(dir, "db"));
	store.migrate();
	const job = store.create(
		createJobSchema.parse({
			topic: "directional budget",
			budget: { inputTokens: 10000, outputTokens: 2000 },
		}),
	);
	job.config.researchFlow = "deliverables-v1";
	store.saveJob(job);
	const task = store.claim()!;
	return {
		store,
		job,
		task,
		engine: new Engine(store),
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("new defaults split one million input and one hundred thousand output; explicit old totals retain semantics", () => {
	expect(budgetSchema.parse({})).toMatchObject({
		tokens: 1100000,
		inputTokens: 1000000,
		outputTokens: 100000,
	});
	expect(budgetSchema.parse({ tokens: 180000 })).toMatchObject({
		tokens: 180000,
	});
	expect(budgetSchema.parse({ tokens: 180000 }).inputTokens).toBeUndefined();
	expect(
		budgetSchema.parse({
			inputTokens: 10000,
			outputTokens: 2000,
			tokens: 999999,
		}).tokens,
	).toBe(12000);
	expect(budgetSchema.safeParse({ inputTokens: 1000001 }).success).toBe(false);
	expect(budgetSchema.safeParse({ outputTokens: 100001 }).success).toBe(false);
});

test.each([
	"inputTokens",
	"outputTokens",
] as const)("atomic admission rejects %s exhaustion with total budget left", (key) => {
	const s = setup();
	try {
		const exhausted =
			key === "inputTokens"
				? { tokens: 10000, inputTokens: 10000, outputTokens: 0 }
				: { tokens: 2000, inputTokens: 0, outputTokens: 2000 };
		s.store.reserve(s.task, exhausted);
		const next = { tokens: 1, [key]: 1, requests: 1 };
		expect(tokenBudgetFits(s.store.getJob(s.job.id)!, next)).toBe(false);
		expect(() => s.store.reserve(s.task, next)).toThrow(BudgetExceeded);
		expect(s.store.getJob(s.job.id)?.usage.requests).toBe(0);
	} finally {
		s.close();
	}
});

test("settles directional actuals once, leaving refunded capacity for the next call", async () => {
	const s = setup();
	try {
		const amount = splitTokenReservation(9000, 1800);
		const execute = () =>
			s.engine.operation(s.task, "directional:1", amount, async () => ({
				usage: 1500,
				tokenUsage: { inputTokens: 1200, outputTokens: 300 },
				audit: {
					usage: { cached_input_tokens: 900, reasoning_output_tokens: 200 },
				},
			}));
		await execute();
		await execute();
		expect(s.store.getJob(s.job.id)?.usage).toMatchObject({
			tokens: 1500,
			inputTokens: 1200,
			outputTokens: 300,
		});
		expect(
			tokenBudgetFits(
				s.store.getJob(s.job.id)!,
				splitTokenReservation(3000, 1000),
			),
		).toBe(true);
		expect(
			s.store.record<{ resultTokenUsage: unknown }>(
				s.job.id,
				"reservation",
				"directional:1",
			)?.resultTokenUsage,
		).toEqual({ inputTokens: 1200, outputTokens: 300 });
	} finally {
		s.close();
	}
});

test("unknown directional usage retains reservations even when aggregate usage is known", async () => {
	const s = setup();
	try {
		await s.engine.operation(
			s.task,
			"unknown",
			splitTokenReservation(7000, 2000),
			async () => ({ usage: 120 }),
		);
		expect(s.store.getJob(s.job.id)?.usage).toMatchObject({
			tokens: 120,
			inputTokens: 5000,
			outputTokens: 2000,
		});
		await expect(
			s.engine.operation(
				s.task,
				"next",
				splitTokenReservation(100, 50),
				async () => ({ usage: 10 }),
			),
		).rejects.toThrow(BudgetExceeded);
	} finally {
		s.close();
	}
});

test("failed external calls retain reservations and cannot be resent", async () => {
	const s = setup();
	try {
		await expect(
			s.engine.operation(
				s.task,
				"failed",
				splitTokenReservation(6000, 1000),
				async () => {
					throw Error("transport lost");
				},
			),
		).rejects.toThrow("transport lost");
		expect(s.store.getJob(s.job.id)?.usage).toMatchObject({
			tokens: 6000,
			inputTokens: 5000,
			outputTokens: 1000,
		});
		await expect(
			s.engine.operation(
				s.task,
				"failed",
				splitTokenReservation(6000, 1000),
				async () => ({ usage: 1 }),
			),
		).rejects.toThrow("EXTERNAL_RESULT_UNKNOWN");
	} finally {
		s.close();
	}
});
