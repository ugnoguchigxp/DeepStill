import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine, mocks } from "../apps/worker/engine";
import { Store, LeaseLost } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { hash } from "../packages/crawler";
import { terminal } from "../packages/core";

interface ReadState {
	phase: string;
	cursors: Record<string, number>;
	committedCursors?: Record<string, number>;
	pendingRead?: { sourceId: string; start: number; end: number; text: string };
	content?: ReadState["pendingRead"];
	repair?: string;
	version: number;
}

test.each([
	"repair",
	"invalid",
	"action-invalid",
	"commit-failure",
	"reconsider",
	"legacy",
	"long",
])("read receipt survives validation and restart: %s", async (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "read-commit-"));
	const store = new Store(join(dir, "test.db"));
	store.migrate();
	const job = store.create(
		createJobSchema.parse({ topic: "説明と条件", budget: { tokens: 500000 } }),
	);
	job.config.researchFlow = "deliverables-v1";
	store.saveJob(job);
	const state = () => {
		const row = store.sql
			.query(
				"SELECT payload FROM tasks WHERE job_id=? ORDER BY rowid DESC LIMIT 1",
			)
			.get(job.id) as { payload: string };
		return JSON.parse(row.payload) as ReadState;
	};
	let writes = 0,
		crashed = false,
		migrated = false,
		sawPending = false;
	const ranges: { start: number; end: number }[] = [];
	const commit = store.commit.bind(store);
	store.commit = (task, fn, payload, done, delay) => {
		const value = payload as ReadState;
		if (
			mode === "commit-failure" &&
			!crashed &&
			Object.keys(value.committedCursors ?? {}).length
		) {
			crashed = true;
			return commit(
				task,
				() => {
					fn();
					throw new LeaseLost();
				},
				payload,
				done,
				delay,
			);
		}
		return commit(task, fn, payload, done, delay);
	};
	try {
		for (
			let step = 0;
			step < 45 && !terminal(store.getJob(job.id)?.status ?? "");
			step++
		) {
			const engine = new Engine(
				store,
				() => ({
					...mocks,
					crawler: {
						...mocks.crawler,
						async crawl(url, signal) {
							const source = await mocks.crawler.crawl(url, signal);
							if (mode !== "long") return source;
							const text = Array.from(
								{ length: 600 },
								(_, i) =>
									`Line ${i}: Evidence with conditions and a reproducible comparison.\n`,
							).join("");
							return { ...source, text, hash: hash(text) };
						},
					},
					llm: {
						async complete(kind, input) {
							if (kind === "deliverable_episode")
								return {
									text: JSON.stringify({
										title: "調査",
										context: "試験",
										intent: "説明",
										observations: "本文",
										decisions: [],
										actionTaken: "読解",
										outcome: "終了",
										outcomeKind: "mixed",
										failedApproach: [],
										lesson: "確認",
										triggers: [],
										openLoops: [],
									}),
									usage: 100,
									audit: {},
								};
							const d = JSON.parse(input);
							const response = (draft: unknown, next: unknown) => ({
								text: JSON.stringify({ draft, next }),
								usage: 100,
								audit: {},
							});
							if (!d.newContent) {
								if (d.sources.length) {
									expect(mode).toBe("reconsider");
									expect(
										store.detail(job.id)?.artifacts.length,
									).toBeGreaterThan(0);
									expect(
										Object.values(state().committedCursors ?? {})[0],
									).toBeGreaterThan(0);
									return response(null, {
										kind: "finish",
										satisfied: false,
										reason: "追加資料なし",
									});
								}
								return response(null, {
									kind: "fetch",
									url: d.discoveries[0].url,
									purpose: "本文",
								});
							}
							writes++;
							const s = state();
							sawPending = true;
							expect(s.pendingRead ?? s.content).toMatchObject({
								start: d.newContent.start,
								end: d.newContent.end,
							});
							expect(s.cursors[d.newContent.sourceId]).toBe(d.newContent.end);
							if (mode !== "legacy")
								expect(s.committedCursors?.[d.newContent.sourceId] ?? 0).toBe(
									d.newContent.start,
								);
							if (d.validationError)
								expect(ranges[0]).toEqual({
									start: d.newContent.start,
									end: d.newContent.end,
								});
							ranges.push({ start: d.newContent.start, end: d.newContent.end });
							const line = d.newContent.lines[0];
							const draft = {
								sections: [
									{
										title: "説明",
										paragraphs: [
											{
												text: line.text,
												kind: "finding",
												citations: [
													{
														sourceId: d.newContent.sourceId,
														firstLine: line.number,
														lastLine: line.number,
													},
												],
											},
										],
									},
								],
								knowledge: [],
								limitations: [],
								openQuestions: [],
							};
							if (mode === "invalid" || (mode === "repair" && writes === 1))
								return response(null, {
									kind: "finish",
									satisfied: true,
									reason: "不正な草稿",
								});
							if (mode === "action-invalid")
								return response(draft, {
									kind: "fetch",
									url: "https://undiscovered.example/test",
									purpose: "不正行動",
								});
							if (mode === "long" && d.newContent.end < d.sources[0].length)
								return response(draft, {
									kind: "read",
									sourceId: d.newContent.sourceId,
									purpose: "続き",
								});
							return response(draft, {
								kind: "finish",
								satisfied: mode !== "reconsider",
								reason: "確認",
							});
						},
					},
				}),
				join(dir, "out"),
			);
			await engine.tick(job.id);
			if (crashed && !Object.keys(state().committedCursors ?? {}).length) {
				expect(store.detail(job.id)?.artifacts).toHaveLength(0);
				expect(state().pendingRead).toBeDefined();
				store.sql.run(
					"UPDATE tasks SET lease_until=0,next_at=0 WHERE job_id=?",
					[job.id],
				);
			}
			if (mode === "legacy" && !migrated && state().pendingRead) {
				const old = state();
				old.content = old.pendingRead;
				delete old.pendingRead;
				delete old.committedCursors;
				store.sql.run("UPDATE tasks SET payload=? WHERE job_id=?", [
					JSON.stringify(old),
					job.id,
				]);
				migrated = true;
			}
		}
		expect(sawPending).toBe(true);
		const final = state();
		if (mode === "invalid" || mode === "action-invalid") {
			expect(final.committedCursors).toEqual({});
			expect(final.pendingRead).toBeDefined();
			expect(store.getJob(job.id)?.reason).toBe("invalid_deliverable");
			expect(
				store.events(job.id).filter((e) => e.type === "read.committed"),
			).toHaveLength(0);
		} else {
			expect(final.pendingRead).toBeUndefined();
			if (mode !== "legacy")
				expect(final.committedCursors).toEqual(final.cursors);
			expect(store.getJob(job.id)?.status).toBe(
				mode === "reconsider" ? "partial" : "completed",
			);
		}
		if (mode === "commit-failure") {
			expect(crashed).toBe(true);
			expect(writes).toBe(1);
		}
		if (mode === "long") {
			expect(ranges.length).toBeGreaterThan(1);
			expect(ranges[1].start).toBe(ranges[0].end);
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
