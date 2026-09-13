import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
import { importRun } from "../packages/db/import-run";
import { createJobSchema } from "../packages/contracts";
import { createApp } from "../apps/api/app";
test("settled run import preserves colliding event IDs, exposes history through API and never schedules work", async () => {
	const dir = mkdtempSync(join(tmpdir(), "import-run-"));
	const source = new Store(join(dir, "source"));
	const target = new Store(join(dir, "target"));
	source.migrate();
	target.migrate();
	try {
		const j = source.create(
			createJobSchema.parse({ topic: "Imported research" }),
		);
		const existing = target.create(
			createJobSchema.parse({ topic: "Existing research" }),
		);
		expect(() => importRun(target, source.path)).toThrow("RUN_NOT_SETTLED");
		source.event(j.id, "query.selected", { query: "actual query" });
		const original = source.events(j.id);
		j.status = "partial";
		source.saveJob(j);
		source.put(j.id, "artifact", "a", {
			id: "a",
			version: 1,
			body: "Actual generated report",
			claimIds: [],
		});
		const before = target.events(existing.id);
		expect(importRun(target, source.path)).toEqual([j.id]);
		expect(target.events(j.id)).toEqual(original);
		expect(target.events(existing.id)).toEqual(before);
		expect(target.detail(j.id)?.artifacts[0].body).toBe(
			"Actual generated report",
		);
		expect(
			target.sql.query("SELECT * FROM tasks WHERE job_id=?").all(j.id),
		).toEqual([]);
		target.event(j.id, "candidate.reviewed", {});
		expect(target.events(j.id).at(-1)!.id).toBeGreaterThan(original.at(-1)!.id);
		expect(target.events(j.id, original.at(-1)!.id)).toHaveLength(1);
		expect(() => importRun(target, source.path)).toThrow("JOB_ALREADY_EXISTS");
		const app = createApp(target);
		const response = await app.request(
			`http://localhost:4310/api/jobs/${j.id}`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).artifacts[0].body).toBe(
			"Actual generated report",
		);
		expect(target.slot().state).toBe("idle");
	} finally {
		source.close();
		target.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
