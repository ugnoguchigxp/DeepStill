import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { narrativeMarkdown } from "../../packages/artifact/narrative";
import { createJobSchema } from "../../packages/contracts";
import { terminal } from "../../packages/core";
import { metrics } from "../../packages/core/metrics";
import type { Store } from "../../packages/db";
import { inspectCodex } from "../../packages/llm-provider/runtime";
import { workerHealth } from "../../packages/runtime";
export function createApp(store: Store) {
	const app = new Hono();
	app.use("*", secureHeaders());
	app.use("/api/*", bodyLimit({ maxSize: 16384 }));
	app.use("/api/*", async (c, next) => {
		const url = new URL(c.req.url);
		const host = url.hostname;
		if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
			return c.json({ error: "LOCAL_ONLY" }, 403);
		const origin = c.req.header("Origin");
		if (origin) {
			let parsed: URL;
			try {
				parsed = new URL(origin);
			} catch {
				return c.json({ error: "INVALID_ORIGIN" }, 403);
			}
			if (
				!["http:", "https:"].includes(parsed.protocol) ||
				!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
				![url.port, "5173", "4310", process.env.PORT].includes(parsed.port)
			)
				return c.json({ error: "INVALID_ORIGIN" }, 403);
		}
		await next();
	});
	app.get("/api/health", (c) => c.json({ ok: true }));
	app.get("/api/ready", (c) => {
		try {
			return c.json({ ready: store.ready() });
		} catch {
			return c.json({ ready: false }, 503);
		}
	});
	const readiness = () => {
		const codex =
			process.env.SEARCH_PROVIDER === "codex" ||
			process.env.LLM_PROVIDER === "codex"
				? inspectCodex()
				: null;
		const worker = workerHealth(store.path);
		const configured = !!(
			(process.env.SEARCH_PROVIDER === "codex" ||
				(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)) &&
			(process.env.LLM_PROVIDER === "codex" || process.env.LLM_MODEL)
		);
		return {
			liveReady: configured && (!codex || codex.ready) && worker.ready,
			worker,
			codex,
		};
	};
	app.get("/api/config", (c) =>
		c.json({
			...readiness(),
			executionBlocked:
				store.slot().state === "blocked" && store.slot().job_id === null,
			contextConnected: !!process.env.CONTEXTSTILL_MCP_URL,
			llmProvider: process.env.LLM_PROVIDER || "compatible",
			model:
				process.env.LLM_PROVIDER === "codex"
					? "gpt-5.6-luna"
					: process.env.LLM_MODEL,
			reasoning: process.env.LLM_PROVIDER === "codex" ? "low" : null,
			searchProvider: process.env.SEARCH_PROVIDER || "dataforseo",
		}),
	);
	app.post("/api/execution/confirm-stopped", async (c) => {
		const p = z
			.object({
				confirmed: z.literal(true),
				reason: z.string().trim().min(5).max(400),
			})
			.safeParse(await c.req.json().catch(() => null));
		if (!p.success) return c.json({ error: "INVALID_INPUT" }, 400);
		try {
			store.confirmDeletedExternalStopped(p.data.reason);
			return c.json({ ok: true });
		} catch {
			return c.json({ error: "NOT_BLOCKED" }, 409);
		}
	});
	app.get("/api/jobs", (c) => c.json(store.listJobs()));
	app.post("/api/jobs", async (c) => {
		const parsed = createJobSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success)
			return c.json(
				{ error: "INVALID_INPUT", issues: parsed.error.issues },
				400,
			);
		if (parsed.data.mode === "live" && !readiness().liveReady)
			return c.json({ error: "LIVE_NOT_READY", ...readiness() }, 503);
		return c.json(store.create(parsed.data), 201);
	});
	app.post("/api/jobs/:id/delete", async (c) => {
		const input = await c.req.json().catch(() => null);
		if (
			input?.confirmed !== true ||
			!z.string().uuid().safeParse(c.req.param("id")).success
		)
			return c.json({ error: "INVALID_INPUT" }, 400);
		try {
			store.deleteJob(c.req.param("id"));
		} catch (e) {
			if (
				e instanceof Error &&
				e.message === "EXTERNAL_STOP_CONFIRMATION_REQUIRED"
			)
				return c.json({ error: e.message }, 409);
			throw e;
		}
		return c.json({ deleted: true });
	});

	app.get("/api/jobs/:id", (c) => {
		const d = store.detail(c.req.param("id"));
		return d ? c.json(d) : c.json({ error: "NOT_FOUND" }, 404);
	});

	app.get("/api/jobs/:id/research", (c) =>
		store.getJob(c.req.param("id"))
			? c.json(store.research(c.req.param("id")))
			: c.json({ error: "NOT_FOUND" }, 404),
	);
	app.patch("/api/jobs/:id/work-items/:itemId", async (c) => {
		const input = z
			.object({
				expectedRevision: z.number().int().nonnegative(),
				priority: z.number().int().min(0).max(100),
			})
			.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
		try {
			return c.json(
				store.reprioritize(
					c.req.param("id"),
					c.req.param("itemId"),
					input.data.expectedRevision,
					input.data.priority,
				),
			);
		} catch (e) {
			const error = e instanceof Error ? e.message : "INTERNAL_ERROR";
			return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
		}
	});
	app.post("/api/jobs/:id/exploration-candidates", async (c) => {
		const input = z
			.object({
				idempotencyKey: z.string().min(1).max(100),
				expectedRevision: z.number().int().nonnegative(),
				question: z.string().trim().min(2).max(400),
				purpose: z.enum(["core", "supplement", "trivia"]),
			})
			.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
		try {
			return c.json(
				store.addExploration(
					c.req.param("id"),
					input.data.idempotencyKey,
					input.data.expectedRevision,
					input.data.question,
					input.data.purpose,
				),
				201,
			);
		} catch (e) {
			const error = e instanceof Error ? e.message : "INTERNAL_ERROR";
			return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
		}
	});
	app.post("/api/jobs/:id/confirm-external-stopped", async (c) => {
		const input = z
			.object({
				confirmed: z.literal(true),
				reason: z.string().trim().min(5).max(400),
			})
			.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
		try {
			store.confirmExternalStopped(c.req.param("id"), input.data.reason);
			return c.json({ ok: true });
		} catch {
			return c.json({ error: "NOT_BLOCKED" }, 409);
		}
	});
	app.get("/api/jobs/:id/report", (c) => {
		const detail = store.detail(c.req.param("id"));
		const artifact = detail?.artifacts[0];
		if (!detail || !artifact) return c.json({ error: "NOT_FOUND" }, 404);
		return new Response(narrativeMarkdown(artifact, detail), {
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				"Content-Disposition": "attachment; filename=research-report.md",
			},
		});
	});
	app.post("/api/jobs/:id/cancel", (c) => {
		const j = store.cancel(c.req.param("id"));
		return j ? c.json(j) : c.json({ error: "NOT_FOUND" }, 404);
	});
	app.post("/api/jobs/:id/resume", (c) => {
		try {
			if (
				store.getJob(c.req.param("id"))?.mode === "live" &&
				!readiness().liveReady
			)
				return c.json({ error: "LIVE_NOT_READY", ...readiness() }, 503);
			const job = store.resume(c.req.param("id"));
			return job ? c.json(job) : c.json({ error: "NOT_FOUND" }, 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (
				[
					"JOB_NOT_RESUMABLE",
					"RESUME_BUDGET_EXHAUSTED",
					"RESUME_TIME_EXHAUSTED",
					"EXTERNAL_STOP_CONFIRMATION_REQUIRED",
				].includes(message)
			)
				return c.json({ error: message }, 409);
			throw error;
		}
	});

	app.get("/api/jobs/:id/candidates", (c) => {
		const d = store.detail(c.req.param("id"));
		if (!d) return c.json({ error: "NOT_FOUND" }, 404);
		return c.json({
			schemaVersion: 1,
			jobId: d.job.id,
			fixture: d.job.mode === "mock",
			candidates: d.candidates,
			claims: d.claims,
			evidence: d.evidence,
			sources: d.sources.map(({ text, ...s }) => s),
		});
	});
	app.get("/api/jobs/:id/metrics", (c) => {
		const d = store.detail(c.req.param("id"));
		return d ? c.json(metrics(d)) : c.json({ error: "NOT_FOUND" }, 404);
	});
	app.post("/api/jobs/:id/candidates/:candidateId/decision", async (c) => {
		const input = z
			.object({ adoption: z.enum(["accepted", "rejected", "pending"]) })
			.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
		const result = store.atomic(() => {
			const detail = store.detail(c.req.param("id"));
			const candidate = detail?.candidates.find(
				(item) => item.id === c.req.param("candidateId"),
			);
			if (!candidate) return null;
			const updated = { ...candidate, adoption: input.data.adoption };
			store.put(c.req.param("id"), "candidate", candidate.id, updated);
			store.event(c.req.param("id"), "candidate.reviewed", {
				candidateId: candidate.id,
				adoption: input.data.adoption,
				source: "manual",
			});
			return updated;
		});
		return result ? c.json(result) : c.json({ error: "NOT_FOUND" }, 404);
	});
	app.get("/api/jobs/:id/events", (c) => {
		const id = c.req.param("id");
		if (!store.getJob(id)) return c.json({ error: "NOT_FOUND" }, 404);
		let after = Number(
			c.req.header("Last-Event-ID") || c.req.query("after") || 0,
		);
		if (!Number.isSafeInteger(after) || after < 0)
			return c.json({ error: "INVALID_CURSOR" }, 400);
		return streamSSE(c, async (stream) => {
			while (!stream.aborted) {
				const events = store.events(id, after);
				for (const e of events) {
					await stream.writeSSE({
						id: String(e.id),
						event: "update",
						data: JSON.stringify(e),
					});
					after = e.id;
				}
				const job = store.getJob(id);
				if (!job || (terminal(job.status) && events.length < 500)) break;
				await stream.writeSSE({ event: "heartbeat", data: "{}" });
				await stream.sleep(1000);
			}
		});
	});
	app.use("/*", serveStatic({ root: "./dist-web" }));
	app.get("*", serveStatic({ path: "./dist-web/index.html" }));
	app.onError((err, c) => {
		console.error(JSON.stringify({ event: "api.error", name: err.name }));
		return c.json({ error: "INTERNAL_ERROR" }, 500);
	});
	return app;
}
