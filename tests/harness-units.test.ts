import { expect, test } from "vitest";
import {
	runReuseCase,
	summarizeReuse,
	type ReuseCase,
} from "../packages/memory/harness";
import { makeDetail, makeMemory } from "./helpers/fixtures";
import type { LlmProvider } from "../packages/llm-provider";

const baseCase = (): ReuseCase => ({
	id: "case-1",
	axis: "knowledge",
	split: "development",
	question: "How are snapshots stored?",
	query: "snapshot",
	expected: ["keep original offsets"],
	sourceIds: ["ev-1"],
	critical: true,
});

function llm(handlers: Partial<Record<string, unknown>>): LlmProvider {
	return {
		async complete(kind) {
			const payload = handlers[kind] ?? handlers.default;
			return {
				text: JSON.stringify(payload),
				usage: 2,
				audit: { kind },
			};
		},
	};
}

test("runReuseCase rejects missing gold, invalid checks and missing critical reasons", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	const signal = new AbortController().signal;
	await expect(
		runReuseCase(
			bundle,
			detail,
			{ ...baseCase(), sourceIds: ["missing"] },
			llm({}),
			signal,
		),
	).rejects.toThrow("REUSE_GOLD_SOURCE_MISSING");
	await expect(
		runReuseCase(
			bundle,
			detail,
			baseCase(),
			llm({
				memory_probe: {
					answer: "ok",
					objectIds: ["k:rule"],
					evidenceIds: ["ev-1"],
					abstained: false,
				},
				memory_judge: {
					checks: [{ index: 0, score: 1, reason: "ok" }],
					criticalFailure: true,
					criticalReasons: [],
				},
			}),
			signal,
		),
	).rejects.toThrow("REUSE_CRITICAL_REASON_MISSING");
	await expect(
		runReuseCase(
			bundle,
			detail,
			baseCase(),
			llm({
				memory_probe: {
					answer: "ok",
					objectIds: ["k:rule"],
					evidenceIds: ["ev-1"],
					abstained: false,
				},
				memory_judge: {
					checks: [],
					criticalFailure: false,
					criticalReasons: [],
				},
			}),
			signal,
		),
	).rejects.toThrow("REUSE_CHECK_COVERAGE");
});

test("runReuseCase interactive retrieval marks invalid references and passing reuse", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	const signal = new AbortController().signal;
	let retrieve = 0;
	const invalid = await runReuseCase(
		bundle,
		detail,
		{ ...baseCase(), axis: "episode", query: "Fixture" },
		{
			async complete(kind) {
				if (kind === "memory_retrieve") {
					retrieve += 1;
					return {
						text: JSON.stringify({
							operation: "answer",
							argument: "",
							reason: "done",
						}),
						usage: 1,
						audit: {},
					};
				}
				if (kind === "memory_probe")
					return {
						text: JSON.stringify({
							answer: "guess",
							objectIds: ["missing-object"],
							evidenceIds: ["missing-evidence"],
							abstained: false,
						}),
						usage: 1,
						audit: {},
					};
				return {
					text: JSON.stringify({
						checks: [{ index: 0, score: 0.5, reason: "partial" }],
						criticalFailure: false,
						criticalReasons: [],
					}),
					usage: 1,
					audit: {},
				};
			},
		},
		signal,
		{ interactive: true },
	);
	expect(retrieve).toBeGreaterThan(0);
	expect(invalid.invalidReferences).toBe(true);
	expect(invalid.criticalFailure).toBe(true);
	expect(invalid.retrievalHistory).not.toBeNull();
	const ok = await runReuseCase(
		bundle,
		detail,
		{ ...baseCase(), axis: "retrieval", sourceIds: ["1"] },
		llm({
			memory_probe: {
				answer: "keep original offsets",
				objectIds: ["k:rule"],
				evidenceIds: ["ev-1"],
				abstained: false,
			},
			memory_judge: {
				checks: [{ index: 0, score: 1, reason: "supported" }],
				criticalFailure: false,
				criticalReasons: [],
			},
		}),
		signal,
	);
	expect(ok.score).toBe(100);
	expect(ok.criticalFailure).toBe(false);
	const summary = summarizeReuse([
		{ ...ok, axis: "knowledge", score: 91, criticalFailure: false },
		{ ...ok, axis: "episode", score: 92, criticalFailure: false },
		{ ...ok, axis: "retrieval", score: 93, criticalFailure: false },
	]);
	expect(summary.pass).toBe(true);
	expect(summary.criticalFailures).toEqual([]);
	expect(
		summarizeReuse([
			{ ...ok, axis: "knowledge", score: 10, criticalFailure: true },
		]).pass,
	).toBe(false);
});
