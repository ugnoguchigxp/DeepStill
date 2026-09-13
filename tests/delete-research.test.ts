import { test, expect } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, LeaseLost } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { Engine, mocks } from "../apps/worker/engine";
import { createApp } from "../apps/api/app";

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "deepstill-delete-"));
	const store = new Store(join(dir, "db.sqlite"));
	store.migrate();
	return {
		dir,
		store,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("physical deletion removes all owned rows and files and fences stale writers", () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "remove all evidence" }),
		);
		const other = s.store.create(
			createJobSchema.parse({ topic: "keep this research" }),
		);
		const task = s.store.claim(30000, job.id);
		if (!task) throw new Error("TASK_MISSING");
		const roots = [join(s.dir, "artifacts"), join(s.dir, "reviews")];
		for (const root of roots) {
			for (const id of [job.id, other.id]) {
				mkdirSync(join(root, id, "1"), { recursive: true });
				writeFileSync(join(root, id, "1", "report.json"), "evidence");
			}
		}
		for (const kind of [
			"query",
			"source",
			"evidence",
			"artifact",
			"operation",
			"quality_review",
		])
			s.store.put(job.id, kind, "record", { text: "stored result" });
		s.store.sql
			.query("INSERT INTO research_work_items VALUES(?,?,?,?,?,?,?,?,?)")
			.run("work", job.id, "round", "query", "running", 1, 0, 0, "{}");
		s.store.acquireSlot(task);
		expect(s.store.deleteJob(job.id, roots)).toBe(true);
		for (const table of ["tasks", "records", "events", "research_work_items"])
			expect(
				s.store.sql.query(`SELECT * FROM ${table} WHERE job_id=?`).all(job.id),
			).toEqual([]);
		expect(s.store.getJob(job.id)).toBeNull();
		expect(s.store.slot().job_id).toBeNull();
		expect(s.store.heartbeat(task)).toBe(false);
		expect(() => s.store.acquireSlot(task)).toThrow(LeaseLost);
		expect(() =>
			s.store.commit(task, () => s.store.put(job.id, "source", "late", {}), {}),
		).toThrow(LeaseLost);
		expect(() => s.store.put(job.id, "source", "late", {})).toThrow();
		for (const root of roots) {
			expect(existsSync(join(root, job.id))).toBe(false);
			expect(existsSync(join(root, other.id, "1", "report.json"))).toBe(true);
		}
		expect(s.store.getJob(other.id)).not.toBeNull();
		expect(s.store.deleteJob(job.id, roots)).toBe(false);
		expect(() => s.store.deleteJob("../outside", roots)).toThrow(
			"INVALID_JOB_ID",
		);
	} finally {
		s.close();
	}
});

test("file cleanup failure keeps the job available for retry", () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "retry deletion" }),
		);
		const root = join(s.dir, "not-a-directory");
		writeFileSync(root, "file");
		expect(() => s.store.deleteJob(job.id, [root])).toThrow();
		expect(s.store.getJob(job.id)).not.toBeNull();
		expect(s.store.events(job.id).length).toBeGreaterThan(0);
	} finally {
		s.close();
	}
});

test("an in-flight provider cannot restore research after deletion", async () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "delete during provider call" }),
		);
		let invoked = false;
		const engine = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(kind, input, signal) {
						invoked = true;
						s.store.deleteJob(job.id, [s.dir]);
						return mocks.llm.complete(kind, input, signal);
					},
				},
			}),
			s.dir,
		);
		for (let i = 0; i < 20 && !invoked; i++) await engine.tick(job.id);
		expect(invoked).toBe(true);
		expect(s.store.detail(job.id)).toBeNull();
		expect(existsSync(join(s.dir, job.id))).toBe(false);
		expect(await engine.tick(job.id)).toBe(false);
	} finally {
		s.close();
	}
});

test("delete API requires confirmation, rejects foreign origins and removes all read routes", async () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "API deletion" }),
		);
		const app = createApp(s.store);
		const url = `http://localhost/api/jobs/${job.id}`;
		const send = (body: unknown, origin?: string) =>
			app.request(`${url}/delete`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(origin ? { Origin: origin } : {}),
				},
				body: JSON.stringify(body),
			});
		expect((await send({})).status).toBe(400);
		expect(
			(await send({ confirmed: true }, "https://evil.example")).status,
		).toBe(403);
		expect(s.store.getJob(job.id)).not.toBeNull();
		expect((await send({ confirmed: true })).status).toBe(200);
		for (const suffix of ["", "/report", "/events", "/candidates", "/metrics"])
			expect((await app.request(url + suffix)).status).toBe(404);
		expect((await send({ confirmed: true })).status).toBe(200);
	} finally {
		s.close();
	}
});

test("deletion aborts a running provider on the next worker heartbeat", async () => {
	const s = setup();
	try {
		const job = s.store.create(
			createJobSchema.parse({ topic: "abort on delete" }),
		);
		let aborted = false;
		let entered = false;
		const engine = new Engine(
			s.store,
			() => ({
				...mocks,
				llm: {
					async complete(_kind, _input, signal) {
						entered = true;
						return new Promise<never>((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									reject(signal.reason);
								},
								{ once: true },
							);
							s.store.deleteJob(job.id, [s.dir]);
						});
					},
				},
			}),
			s.dir,
		);
		for (let i = 0; i < 20 && !entered; i++) await engine.tick(job.id);
		expect(entered).toBe(true);
		expect(aborted).toBe(true);
		expect(s.store.detail(job.id)).toBeNull();
		expect(s.store.slot().job_id).toBeNull();
	} finally {
		s.close();
	}
});
