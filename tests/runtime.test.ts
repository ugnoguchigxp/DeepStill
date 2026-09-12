import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexPath } from "../packages/llm-provider/runtime";
import { publishWorker, workerHealth } from "../packages/runtime";
import { Store } from "../packages/db";
import { createApp } from "../apps/api/app";
test("CLI resolution does not fall back to an old bundled SDK executable", () => {
	expect(() =>
		resolveCodexPath({ PATH: "/nonexistent/node_modules/.bin:/nonexistent" }),
	).toThrow("CODEX_CLI_NOT_FOUND");
	expect(resolveCodexPath({ CODEX_PATH: "/explicit/codex", PATH: "" })).toBe(
		"/explicit/codex",
	);
});
test("readiness rejects missing, outdated and expired workers", () => {
	const dir = mkdtempSync(join(tmpdir(), "deepstill-health-"));
	const db = join(dir, "db");
	try {
		expect(workerHealth(db, "v1").ready).toBe(false);
		publishWorker(db, "v1");
		expect(workerHealth(db, "v1").ready).toBe(true);
		expect(workerHealth(db, "v2").stale).toBe(true);
		writeFileSync(
			`${db}.worker.json`,
			JSON.stringify({ pid: 1, at: Date.now() - 7000, version: "v1" }),
		);
		expect(workerHealth(db, "v1").ready).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("API refuses real research without a working worker instead of accepting a stuck job", async () => {
	const store = new Store(":memory:");
	store.migrate();
	try {
		const app = createApp(store);
		const result = await app.request("http://localhost/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ topic: "real research", mode: "live" }),
		});
		expect(result.status).toBe(503);
		expect(store.listJobs()).toHaveLength(0);
	} finally {
		store.close();
	}
});
