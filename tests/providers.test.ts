import { test, expect } from "vitest";
import { DataForSeo } from "../packages/search-provider";
import { CompatibleLlm } from "../packages/llm-provider";
import { ContextStillMcp } from "../packages/integrations/contextstill";
import { createApp } from "../apps/api/app";
import { Store } from "../packages/db";
const signal = new AbortController().signal;
function fake(
	fn: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
	return ((url: unknown, init?: RequestInit) =>
		Promise.resolve(fn(String(url), init))) as typeof fetch;
}
test("DataForSEO separates autocomplete/live, task_post, and polling", async () => {
	const calls: string[] = [];
	const p = new DataForSeo(
		"a",
		"b",
		fake((url) => {
			calls.push(url);
			return Response.json({
				status_code: 20000,
				cost: 0.001,
				tasks: [
					url.includes("autocomplete")
						? {
								status_code: 20000,
								result: [
									{ items: [{ type: "autocomplete", suggestion: "related" }] },
								],
							}
						: url.includes("task_post")
							? { status_code: 20100, id: "task-id" }
							: {
									status_code: 20000,
									result: [
										{
											items: [
												{
													type: "organic",
													url: "https://example.org",
													title: "Title",
													rank_absolute: 1,
												},
												{ type: "paid", url: "https://ad.example" },
											],
										},
									],
								},
				],
			});
		}),
	);
	expect((await p.suggest("topic", signal)).suggestions).toEqual(["related"]);
	expect((await p.submit("topic", signal)).id).toBe("task-id");
	expect((await p.poll("task-id", signal)).hits).toHaveLength(1);
	expect(calls[2]).toMatch(/\/task_get\/advanced\/task-id$/);
});
test("DataForSEO pending task is not empty successful search", async () => {
	const p = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({ status_code: 20000, tasks: [{ status_code: 40602 }] }),
		),
	);
	expect((await p.poll("id", signal)).ready).toBe(false);
});
test("LLM sends bounded output and preserves unavailable usage", async () => {
	let body: Record<string, unknown> = {};
	const p = new CompatibleLlm(
		"http://localhost/v1",
		"test",
		"",
		fake((_u, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({
				choices: [{ message: { content: '{"claims":[]}' } }],
			});
		}),
	);
	const result = await p.complete("extract", "source", signal);
	expect(body.max_tokens).toBe(2048);
	expect(body.stream).toBe(false);
	expect(result.usage).toBeNull();
	expect(result.audit).toBeDefined();
});
test("ContextStill only calls read-only search and reports disconnection failures", async () => {
	let method = "";
	const p = new ContextStillMcp(
		"http://localhost/mcp",
		"",
		fake((_u, init) => {
			const req = JSON.parse(String(init?.body || "{}"));
			if (req.method === "initialize")
				return Response.json({
					jsonrpc: "2.0",
					id: req.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					},
				});
			if (req.method === "notifications/initialized")
				return new Response(null, { status: 202 });
			if (!req.method) return new Response(null, { status: 405 });
			method = req.params.name;
			return Response.json({
				jsonrpc: "2.0",
				id: req.id,
				result: { content: [{ type: "text", text: "no content" }] },
			});
		}),
	);
	expect((await p.lookup("q", signal)).state).toBe("explore");
	expect(method).toBe("search_knowledge");
	const bad = new ContextStillMcp(
		"http://localhost/mcp",
		"",
		fake(() => new Response("", { status: 500 })),
	);
	expect((await bad.lookup("q", signal)).state).toBe("unavailable");
});
test("API validates budget and rejects remote origins", async () => {
	const s = new Store(":memory:");
	s.migrate();
	try {
		const app = createApp(s);
		const r = await app.request("http://localhost/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ topic: "research" }),
		});
		expect(r.status).toBe(201);
		const invalid = await app.request("http://localhost/api/jobs", {
			method: "POST",
			body: JSON.stringify({ topic: "x", budget: { tokens: -1 } }),
		});
		expect(invalid.status).toBe(400);
		const cross = await app.request("http://localhost/api/jobs", {
			headers: { Origin: "https://evil.example" },
		});
		expect(cross.status).toBe(403);
	} finally {
		s.close();
	}
});

test("candidate adoption cannot mutate a historical artifact version", async () => {
	const s = new Store(":memory:");
	s.migrate();
	try {
		const { createJobSchema } = await import("../packages/contracts");
		const j = s.create(createJobSchema.parse({ topic: "candidate history" }));
		s.put(j.id, "artifact", "new", { id: "new", version: 2 });
		for (const version of [1, 2])
			s.put(j.id, "candidate", `c${version}`, {
				id: `c${version}`,
				artifactVersion: version,
				type: "knowledge",
				text: "claim",
				claimIds: [],
				adoption: "pending",
			});
		const app = createApp(s);
		for (const version of [1, 2]) {
			const response = await app.request(
				`http://localhost/api/jobs/${j.id}/candidates/c${version}/decision`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ adoption: "accepted" }),
				},
			);
			expect(response.status).toBe(version === 1 ? 404 : 200);
		}
		expect(
			s.record<{ adoption: string }>(j.id, "candidate", "c1")?.adoption,
		).toBe("pending");
	} finally {
		s.close();
	}
});

test("compatible LLM preserves separate input and output usage without adding cached or reasoning subsets", async () => {
	const p = new CompatibleLlm(
		"http://localhost/v1",
		"test",
		"",
		fake(() =>
			Response.json({
				choices: [{ message: { content: "{}" } }],
				usage: {
					total_tokens: 150,
					prompt_tokens: 100,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 80 },
					completion_tokens_details: { reasoning_tokens: 30 },
				},
			}),
		),
	);
	const result = await p.complete("scope", "{}", signal);
	expect(result.usage).toBe(150);
	expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
});
