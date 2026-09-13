import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";

test("blocked execution slot can be confirmed after a deleted job", () => {
	const dir = mkdtempSync(join(tmpdir(), "slot-"));
	const store = new Store(join(dir, "db.sqlite"));
	store.migrate();
	try {
		const job = store.create(createJobSchema.parse({ topic: "blocked slot" }));
		const task = store.claim(30000, job.id);
		if (!task) throw new Error("missing task");
		store.acquireSlot(task);
		store.markExternal(task, "pending:search");
		store.deleteJob(job.id, [join(dir, "artifacts")]);
		expect(store.slot().state).toBe("blocked");
		store.confirmDeletedExternalStopped("vendor dashboard shows stopped");
		expect(store.slot().state).toBe("idle");
		expect(() =>
			store.confirmDeletedExternalStopped("vendor dashboard shows stopped"),
		).toThrow("NOT_BLOCKED");
		const next = store.create(createJobSchema.parse({ topic: "next job" }));
		const held = store.claim(30000, next.id);
		if (!held) throw new Error("missing");
		store.acquireSlot(held);
		store.markExternal(held, "pending:poll");
		store.sql.run("UPDATE execution_slot SET state='blocked'");
		store.confirmExternalStopped(next.id, "operator confirmed stop");
		expect(store.slot().state).toBe("idle");
		expect(() =>
			store.confirmExternalStopped(next.id, "operator confirmed stop"),
		).toThrow("NOT_BLOCKED");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
