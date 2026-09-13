import { expect, test } from "vitest";
import { retrieveQuestion } from "../packages/memory/retrieval";
import { makeDetail, makeMemory, makeSource } from "./helpers/fixtures";
import { runReuseCase } from "../packages/memory/harness";
import { groundedSchema } from "../packages/llm-provider/codex";

test.each([
	"event:1",
	"1",
])("event retrieval accepts the observed event identity %s", async (argument) => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	let step = 0;
	const result = await retrieveQuestion(
		bundle,
		detail,
		"record",
		{
			async complete(_kind, input) {
				if (step === 2) expect(JSON.parse(input).canAnswer).toBe(true);
				return {
					text: JSON.stringify(
						[
							{ operation: "search", argument: "job.started", reason: "find" },
							{ operation: "event", argument, reason: "read" },
							{ operation: "answer", argument: "", reason: "done" },
						][step++],
					),
					usage: 1,
					audit: {},
				};
			},
		},
		new AbortController().signal,
	);
	expect(result.events).toEqual([detail.events[0]]);
});

test("a duplicate request receives feedback and can recover with direct evidence within the same limit", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	let step = 0;
	const result = await retrieveQuestion(
		bundle,
		detail,
		"snapshot",
		{
			async complete(_kind, input) {
				if (step === 3) expect(JSON.parse(input).canAnswer).toBe(true);
				return {
					text: JSON.stringify(
						[
							{ operation: "search", argument: "snapshot", reason: "find" },
							{ operation: "search", argument: "snapshot", reason: "repeat" },
							{ operation: "evidence", argument: "ev-1", reason: "recover" },
							{ operation: "answer", argument: "", reason: "done" },
						][step++],
					),
					usage: 1,
					audit: {},
				};
			},
		},
		new AbortController().signal,
		4,
	);
	expect(result.history.filter((h) => h.operation === "search")).toHaveLength(
		1,
	);
	expect(result.history[1].result).toMatchObject({
		error: "DUPLICATE_RETRIEVAL_REQUEST",
	});
	expect(result.evidence).toMatchObject([{ evidenceId: "ev-1" }]);
	expect(result.calls).toHaveLength(4);
});

test("search previews cannot finish retrieval before a discovered object is read", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	const steps = [
		{ operation: "search", argument: "snapshot", reason: "find" },
		{ operation: "answer", argument: "preview is enough", reason: "premature" },
		{ operation: "object", argument: "ev-1", reason: "read" },
		{ operation: "answer", argument: "", reason: "done" },
	];
	let step = 0;
	const result = await retrieveQuestion(
		bundle,
		detail,
		"snapshots",
		{
			async complete(_kind, input) {
				const data = JSON.parse(input);
				const schema = groundedSchema("memory_retrieve", input) as unknown as {
					properties: { operation: { enum: string[] } };
				};
				expect(schema.properties.operation.enum.includes("answer")).toBe(
					data.canAnswer,
				);
				return { text: JSON.stringify(steps[step++]), usage: 1, audit: {} };
			},
		},
		new AbortController().signal,
	);
	expect(result.history[1].result).toEqual({
		error: "DETAIL_REQUIRED_BEFORE_ANSWER",
	});
	expect(result.evidence).toMatchObject([{ evidenceId: "ev-1" }]);
});

test("a raw Evidence object supplies its actual quote to both consumer and judge", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	let step = 0;
	const seen: Record<string, unknown> = {};
	await runReuseCase(
		bundle,
		detail,
		{
			id: "raw-evidence",
			axis: "retrieval",
			split: "development",
			question: "How are snapshots stored?",
			query: "snapshot",
			expected: ["Recover the original quote"],
			sourceIds: ["ev-1"],
			critical: true,
		},
		{
			async complete(kind, input) {
				const data = JSON.parse(input);
				let value: unknown;
				if (kind === "memory_retrieve")
					value = [
						{ operation: "search", argument: "snapshot", reason: "find" },
						{ operation: "object", argument: "ev-1", reason: "read original" },
						{ operation: "answer", argument: "", reason: "done" },
					][step++];
				else if (kind === "memory_probe") {
					seen.consumer = data.evidence;
					seen.consumerObjects = data.objects;
					value = {
						answer: "Saved quote",
						objectIds: ["ev-1"],
						evidenceIds: ["ev-1"],
						abstained: false,
					};
				} else {
					seen.judge = data.suppliedSources.evidence;
					seen.judgeObjects = data.suppliedSources.objects;
					value = {
						checks: [{ index: 0, score: 1, reason: "supported" }],
						criticalFailure: false,
						criticalReasons: [],
					};
				}
				return { text: JSON.stringify(value), usage: 1, audit: {} };
			},
		},
		new AbortController().signal,
		{ interactive: true },
	);
	expect(seen.consumer).toEqual(seen.judge);
	expect(seen.consumerObjects).toEqual(seen.judgeObjects);
	expect(seen.consumer).toMatchObject([
		{ evidenceId: "ev-1", quote: detail.evidence[0].quote },
	]);
});

test("retrieveQuestion walks search, object, event, index, range and duplicate stops", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({
		events: detail.events,
	});
	const source = makeSource();
	const steps = [
		{ operation: "search", argument: "snapshot", reason: "find" },
		{ operation: "object", argument: "k:rule", reason: "read" },
		{ operation: "object", argument: "ep:run", reason: "episode" },
		{ operation: "event", argument: "1", reason: "history" },
		{ operation: "source_index", argument: "src-1", reason: "index" },
		{
			operation: "source_range",
			argument: JSON.stringify({
				snapshotId: source.id,
				hash: source.hash,
				start: 0,
				end: 12,
			}),
			reason: "range",
		},
		{ operation: "answer", argument: "", reason: "done" },
	];
	let i = 0;
	const result = await retrieveQuestion(
		bundle,
		detail,
		"How are snapshots stored?",
		{
			async complete() {
				return {
					text: JSON.stringify(
						steps[i++] ?? { operation: "answer", argument: "", reason: "done" },
					),
					usage: 1,
					audit: {},
				};
			},
		},
		new AbortController().signal,
		8,
	);
	expect(result.objects.length).toBeGreaterThan(0);
	expect(result.ranges.length).toBeGreaterThan(0);
	expect(result.events.length).toBeGreaterThan(0);
	const missed = await retrieveQuestion(
		bundle,
		detail,
		"missing",
		{
			async complete() {
				return {
					text: JSON.stringify({
						operation: "object",
						argument: "unknown",
						reason: "nope",
					}),
					usage: 1,
					audit: {},
				};
			},
		},
		new AbortController().signal,
		1,
	);
	expect(missed.history[0].result).toMatchObject({
		error: "REFERENCE_NOT_DISCOVERED",
	});
});

test("retrieveQuestion reads evidence, rejects undiscovered ranges and stops duplicates", async () => {
	const detail = makeDetail();
	const bundle = makeMemory({ events: detail.events });
	const source = makeSource();
	const steps = [
		{ operation: "search", argument: "snapshot", reason: "find" },
		{ operation: "object", argument: "k:rule", reason: "read" },
		{ operation: "evidence", argument: "ev-1", reason: "quote" },
		{ operation: "source_index", argument: "missing-src", reason: "skip" },
		{
			operation: "source_range",
			argument: "{",
			reason: "bad json",
		},
		{
			operation: "source_range",
			argument: JSON.stringify({
				snapshotId: source.id,
				hash: "nope",
				start: 0,
				end: 4,
			}),
			reason: "hash",
		},
		{ operation: "search", argument: "snapshot", reason: "again" },
	];
	let i = 0;
	const result = await retrieveQuestion(
		bundle,
		detail,
		"evidence path",
		{
			async complete() {
				return {
					text: JSON.stringify(
						steps[i++] ?? {
							operation: "answer",
							argument: "",
							reason: "done",
						},
					),
					usage: 1,
					audit: {},
				};
			},
		},
		new AbortController().signal,
		8,
	);
	expect(result.evidence.length).toBeGreaterThan(0);
	expect(
		result.history.some(
			(h) =>
				h.operation === "source_range" &&
				typeof h.result === "object" &&
				h.result !== null &&
				"error" in h.result,
		),
	).toBe(true);
	expect(result.history.filter((h) => h.operation === "search")).toHaveLength(
		1,
	);
});
