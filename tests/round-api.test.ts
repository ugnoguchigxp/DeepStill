import { test, expect } from "bun:test";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { createApp } from "../apps/api/app";
import { Engine, mocks } from "../apps/worker/engine";
test("research API validates input, exposes persisted revision, and rejects stale writes", async () => {
	const store = new Store(":memory:");
	store.migrate();
	try {
		const j = store.create(createJobSchema.parse({ topic: "API research" }));
		const engine = new Engine(store, () => mocks, "/tmp/deepstill-api-test");
		await engine.tick(j.id);
		const app = createApp(store);
		const item = store.workItems(j.id).find((w) => w.status === "pending");
		if (!item) throw new Error("MISSING_WORK");
		const path = `http://localhost/api/jobs/${j.id}`;
		const patch = (priority: number) =>
			app.request(`${path}/work-items/${item.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ expectedRevision: item.revision, priority }),
			});
		expect((await patch(101)).status).toBe(400);
		expect((await patch(99)).status).toBe(200);
		expect((await patch(1)).status).toBe(409);
		const response = await app.request(`${path}/research`);
		expect(
			(await response.json()).items.find(
				(w: { id: string }) => w.id === item.id,
			).priority,
		).toBe(99);
	} finally {
		store.close();
	}
});
