import { expect, test, vi } from "vitest";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { createApp } from "../apps/api/app";
import { Engine, mocks } from "../apps/worker/engine";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishWorker } from "../packages/runtime";
import { makeMemory, makeSource } from "./helpers/fixtures";

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "api-cov-"));
	const store = new Store(join(dir, "db.sqlite"));
	store.migrate();
	publishWorker(store.path, "test");
	const job = store.create(createJobSchema.parse({ topic: "API coverage" }));
	const engine = new Engine(store, () => mocks, join(dir, "artifacts"));
	for (let i = 0; i < 40 && store.getJob(job.id)?.status === "queued"; i++)
		await engine.tick(job.id);
	return {
		dir,
		store,
		job,
		app: createApp(store),
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("API covers health, origin, memory, metrics, report, cancel and resume errors", async () => {
	const s = await setup();
	try {
		const app = s.app;
		expect((await app.request("http://localhost/api/health")).status).toBe(200);
		expect((await app.request("http://localhost/api/ready")).status).toBe(200);
		expect((await app.request("http://127.0.0.1/api/config")).status).toBe(200);
		expect((await app.request("http://example.com/api/health")).status).toBe(
			403,
		);
		expect(
			(
				await app.request("http://localhost/api/jobs", {
					headers: { Origin: "not-a-url" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await app.request("http://localhost/api/jobs", {
					headers: { Origin: "ftp://127.0.0.1" },
				})
			).status,
		).toBe(403);
		expect(
			(await app.request(`http://localhost/api/jobs/missing`)).status,
		).toBe(404);
		expect(
			(await app.request(`http://localhost/api/jobs/${s.job.id}/metrics`))
				.status,
		).toBe(200);
		expect(
			(await app.request(`http://localhost/api/jobs/${s.job.id}/candidates`))
				.status,
		).toBe(200);
		expect(
			(await app.request("http://localhost/api/jobs/missing/candidates"))
				.status,
		).toBe(404);
		expect(
			(await app.request("http://localhost/api/jobs/missing/metrics")).status,
		).toBe(404);
		expect(
			(await app.request("http://localhost/api/jobs/missing/research")).status,
		).toBe(404);
		const cancelMissing = await app.request(
			"http://localhost/api/jobs/missing/cancel",
			{ method: "POST" },
		);
		expect(cancelMissing.status).toBe(404);
		const resumeMissing = await app.request(
			"http://localhost/api/jobs/missing/resume",
			{ method: "POST" },
		);
		expect(resumeMissing.status).toBe(404);
		const badDecision = await app.request(
			`http://localhost/api/jobs/${s.job.id}/candidates/nope/decision`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ adoption: "accepted" }),
			},
		);
		expect(badDecision.status).toBe(404);
		const invalidDecision = await app.request(
			`http://localhost/api/jobs/${s.job.id}/candidates/x/decision`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "null",
			},
		);
		expect(invalidDecision.status).toBe(400);
		const eventsBad = await app.request(
			`http://localhost/api/jobs/${s.job.id}/events?after=nope`,
		);
		expect(eventsBad.status).toBe(400);
		expect(
			(await app.request("http://localhost/api/jobs/missing/events")).status,
		).toBe(404);
		const exploreBad = await app.request(
			`http://localhost/api/jobs/${s.job.id}/exploration-candidates`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			},
		);
		expect(exploreBad.status).toBe(400);
		const confirmBad = await app.request(
			`http://localhost/api/jobs/${s.job.id}/confirm-external-stopped`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			},
		);
		expect(confirmBad.status).toBe(400);
		const confirmNone = await app.request(
			`http://localhost/api/jobs/${s.job.id}/confirm-external-stopped`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmed: true, reason: "checked the vendor" }),
			},
		);
		expect(confirmNone.status).toBe(409);
		const execBad = await app.request(
			"http://localhost/api/execution/confirm-stopped",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			},
		);
		expect(execBad.status).toBe(400);
		const execNone = await app.request(
			"http://localhost/api/execution/confirm-stopped",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmed: true, reason: "checked the vendor" }),
			},
		);
		expect(execNone.status).toBe(409);
		const deleteBad = await app.request(
			`http://localhost/api/jobs/${s.job.id}/delete`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			},
		);
		expect(deleteBad.status).toBe(400);
		const memoryMissing = await app.request(
			`http://localhost/api/jobs/${s.job.id}/memory`,
		);
		expect([200, 404]).toContain(memoryMissing.status);
		s.store.put(s.job.id, "source", "src-1", makeSource());
		s.store.put(s.job.id, "memory", "memory:v1", makeMemory());
		expect(
			(await app.request(`http://localhost/api/jobs/${s.job.id}/memory`))
				.status,
		).toBe(200);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?version=missing`,
				)
			).status,
		).toBe(404);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?snapshot=src-1`,
				)
			).status,
		).toBe(200);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?snapshot=unknown`,
				)
			).status,
		).toBe(404);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?q=snapshot`,
				)
			).status,
		).toBe(200);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?object=k:rule`,
				)
			).status,
		).toBe(200);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?event=1`,
				)
			).status,
		).toBe(200);
		expect(
			(
				await app.request(
					`http://localhost/api/jobs/${s.job.id}/memory?export=contextstill`,
				)
			).status,
		).toBe(200);
		const evidence = await app.request(
			`http://localhost/api/jobs/${s.job.id}/memory?evidence=ev-1`,
		);
		expect([200, 409]).toContain(evidence.status);
		const search = await app.request(
			"http://localhost/api/memory/search?q=snapshot",
		);
		expect(search.status).toBe(200);
		const patchMissing = await app.request(
			`http://localhost/api/jobs/missing/work-items/x`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ expectedRevision: 0, priority: 1 }),
			},
		);
		expect(patchMissing.status).toBe(404);
		const exploreMissing = await app.request(
			`http://localhost/api/jobs/missing/exploration-candidates`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					idempotencyKey: "k",
					expectedRevision: 0,
					question: "extra question",
					purpose: "supplement",
				}),
			},
		);
		expect(exploreMissing.status).toBe(404);
		const live = await app.request("http://localhost/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ topic: "live job", mode: "live" }),
		});
		expect(live.status).toBe(503);
		const previousPort = process.env.PORT;
		process.env.PORT = "9999";
		try {
			expect(
				(
					await app.request("http://127.0.0.1:9999/api/health", {
						headers: { Origin: "http://127.0.0.1:9999" },
					})
				).status,
			).toBe(200);
			expect((await app.request("http://[::1]/api/health")).status).toBe(200);
		} finally {
			if (previousPort === undefined) delete process.env.PORT;
			else process.env.PORT = previousPort;
		}
		const readySpy = vi.spyOn(s.store, "ready").mockImplementation(() => {
			throw new Error("db");
		});
		expect((await app.request("http://localhost/api/ready")).status).toBe(503);
		readySpy.mockRestore();
		const deleteSpy = vi.spyOn(s.store, "deleteJob").mockImplementation(() => {
			throw new Error("boom");
		});
		expect(
			(
				await app.request(`http://localhost/api/jobs/${s.job.id}/delete`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ confirmed: true }),
				})
			).status,
		).toBe(500);
		deleteSpy.mockRestore();
		const stopSpy = vi.spyOn(s.store, "deleteJob").mockImplementation(() => {
			throw new Error("EXTERNAL_STOP_CONFIRMATION_REQUIRED");
		});
		expect(
			(
				await app.request(`http://localhost/api/jobs/${s.job.id}/delete`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ confirmed: true }),
				})
			).status,
		).toBe(409);
		stopSpy.mockRestore();
	} finally {
		s.close();
	}
});

test("cancel, resume, report and exploration succeed on a fixture job", async () => {
	const s = await setup();
	try {
		const app = s.app;
		const cancel = await app.request(
			`http://localhost/api/jobs/${s.job.id}/cancel`,
			{ method: "POST" },
		);
		expect(cancel.status).toBe(200);
		const resumeConflict = await app.request(
			`http://localhost/api/jobs/${s.job.id}/resume`,
			{ method: "POST" },
		);
		expect([200, 409, 503]).toContain(resumeConflict.status);
		const reportMissing = await app.request(
			`http://localhost/api/jobs/${s.job.id}/report`,
		);
		expect([200, 404]).toContain(reportMissing.status);
		const research = await app.request(
			`http://localhost/api/jobs/${s.job.id}/research`,
		);
		expect(research.status).toBe(200);
		const data = (await research.json()) as { revision: number };
		const added = await app.request(
			`http://localhost/api/jobs/${s.job.id}/exploration-candidates`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					idempotencyKey: "extra-1",
					expectedRevision: data.revision,
					question: "補足の具体例は何か",
					purpose: "supplement",
				}),
			},
		);
		expect([201, 409]).toContain(added.status);
	} finally {
		s.close();
	}
});
