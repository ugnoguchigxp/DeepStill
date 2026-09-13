import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
test("two real processes race for one task; killed owner is recovered", async () => {
	const dir = mkdtempSync(join(tmpdir(), "deepstill-process-"));
	const path = join(dir, "test.sqlite");
	const store = new Store(path);
	store.migrate();
	try {
		const j = store.create(
			createJobSchema.parse({ topic: "process recovery" }),
		);
		const children = [1, 2].map(() =>
			Bun.spawn(["bun", "tests/helpers/lease-child.ts", path, "1000"], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const results = await Promise.all(
			children.map(async (c) => {
				const text = await new Response(c.stdout).text();
				expect(await c.exited).toBe(0);
				return JSON.parse(text);
			}),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.find(Boolean).job_id).toBe(j.id);
		store.sql.run("UPDATE tasks SET lease_until=0");
		const holder = Bun.spawn(
			["bun", "tests/helpers/lease-child.ts", path, "100", "hold"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const reader = holder.stdout.getReader();
		const { value } = await reader.read();
		const old = JSON.parse(new TextDecoder().decode(value));
		holder.kill("SIGKILL");
		await holder.exited;
		await Bun.sleep(130);
		const recovered = store.claim();
		expect(recovered?.job_id).toBe(j.id);
		expect(recovered?.token).not.toBe(old.token);
		expect(() => store.commit(old, () => {}, {})).toThrow("LEASE_LOST");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("two worker processes cannot own the global slot for different jobs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "deepstill-global-"));
	const path = join(dir, "test.sqlite");
	const store = new Store(path);
	store.migrate();
	try {
		const jobs = ["one", "two"].map((topic) =>
			store.create(createJobSchema.parse({ topic })),
		);
		const children = jobs.map((j) =>
			Bun.spawn(["bun", "tests/helpers/slot-child.ts", path, j.id], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const outcomes = await Promise.all(
			children.map(async (c) => {
				const output = JSON.parse(await new Response(c.stdout).text());
				expect(await c.exited).toBe(0);
				return output;
			}),
		);
		expect(outcomes.filter((o) => o.acquired)).toHaveLength(1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
