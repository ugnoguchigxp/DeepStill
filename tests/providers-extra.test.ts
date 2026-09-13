import { expect, test } from "vitest";
import { DataForSeo, SearchProviderError } from "../packages/search-provider";
import { CompatibleLlm } from "../packages/llm-provider";
import {
	ContextStillMcp,
	emptyKnowledge,
} from "../packages/integrations/contextstill";
import { transcodeLegacyHtml } from "../packages/crawler/encoding";
import { parseScope } from "../packages/research/scope";
import { filterResearchClaims } from "../packages/research/filter";
import { evaluationHold, finalHold, fits } from "../packages/research/budget";
import { makeClaim, makeDetail, makeJob } from "./helpers/fixtures";

const signal = new AbortController().signal;
function fake(
	fn: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
	return ((url: unknown, init?: RequestInit) =>
		Promise.resolve(fn(String(url), init))) as typeof fetch;
}

test("DataForSEO surfaces retryable HTTP, empty tasks and task status errors", async () => {
	const http = new DataForSeo(
		"a",
		"b",
		fake(() => new Response("nope", { status: 503 })),
	);
	await expect(http.suggest("q", signal)).rejects.toBeInstanceOf(
		SearchProviderError,
	);
	const empty = new DataForSeo(
		"a",
		"b",
		fake(() => Response.json({ status_code: 20000, tasks: [] })),
	);
	await expect(empty.suggest("q", signal)).rejects.toThrow("SEARCH_EMPTY_TASK");
	const bad = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({
				status_code: 50000,
				cost: 0,
				tasks: [{ status_code: 1 }],
			}),
		),
	);
	await expect(bad.suggest("q", signal)).rejects.toThrow("SEARCH_STATUS_50000");
	const taskBad = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({
				status_code: 20000,
				tasks: [{ status_code: 40100, result: null }],
			}),
		),
	);
	await expect(taskBad.suggest("q", signal)).rejects.toThrow(
		"SEARCH_STATUS_40100",
	);
	const submitBad = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({
				status_code: 20000,
				tasks: [{ status_code: 20000, id: "x" }],
			}),
		),
	);
	await expect(submitBad.submit("q", signal)).rejects.toThrow(
		"SEARCH_STATUS_20000",
	);
	const pollError = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({
				status_code: 20000,
				tasks: [{ status_code: 40100 }],
			}),
		),
	);
	await expect(pollError.poll("id", signal)).rejects.toThrow(
		"SEARCH_STATUS_40100",
	);
	const pollWait = new DataForSeo(
		"a",
		"b",
		fake(() =>
			Response.json({
				status_code: 20000,
				tasks: [{ status_code: 20100 }],
			}),
		),
	);
	expect((await pollWait.poll("id", signal)).ready).toBe(false);
});

test("LLM rejects HTTP errors and records usage when provided", async () => {
	const failing = new CompatibleLlm(
		"http://localhost/v1/",
		"m",
		"secret",
		fake(() => new Response("no", { status: 500 })),
	);
	await expect(failing.complete("extract", "{}", signal)).rejects.toThrow(
		"LLM_HTTP_500",
	);
	const ok = new CompatibleLlm(
		"http://localhost/v1/",
		"m",
		"secret",
		fake(() =>
			Response.json({
				choices: [{ message: { content: '{"claims":[]}' } }],
				usage: { total_tokens: 12 },
			}),
		),
	);
	expect((await ok.complete("extract", "{}", signal)).usage).toBe(12);
});

test("ContextStill maps knowledge hits, exact titles, degradation and abort", async () => {
	expect((await emptyKnowledge.lookup("q", signal)).state).toBe("disconnected");
	const items = (
		payload: unknown,
		init?: { error?: boolean; status?: number },
	) =>
		new ContextStillMcp(
			"http://localhost/mcp",
			"key",
			fake((_u, request) => {
				const req = JSON.parse(String(request?.body || "{}"));
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
				if (init?.error)
					return Response.json({
						jsonrpc: "2.0",
						id: req.id,
						result: { isError: true, content: [] },
					});
				return Response.json({
					jsonrpc: "2.0",
					id: req.id,
					result: {
						content: [{ type: "text", text: JSON.stringify(payload) }],
					},
				});
			}),
		);
	expect(
		(
			await items({
				items: [{ id: "1", title: "Topic", body: "body" }],
			}).lookup("Topic", signal)
		).state,
	).toBe("verify");
	expect(
		(
			await items({
				items: [{ id: "1", title: "Other", body: "body" }],
			}).lookup("Topic", signal)
		).reason,
	).toContain("関連");
	expect((await items({ items: [] }).lookup("Topic", signal)).state).toBe(
		"explore",
	);
	expect(
		(
			await items({
				items: [{ id: "1", title: "Topic", body: "body" }],
				diagnostics: { degradedReasons: ["timeout"] },
			}).lookup("Topic", signal)
		).state,
	).toBe("unavailable");
	expect((await items({}, { error: true }).lookup("Topic", signal)).state).toBe(
		"unavailable",
	);
	const aborted = new AbortController();
	aborted.abort(new Error("stopped"));
	await expect(
		items({ items: [] }).lookup("Topic", aborted.signal),
	).rejects.toThrow("stopped");
});

test("legacy HTML ignores non-html and unknown charsets", () => {
	const raw = {
		requestedUrl: "https://example.com/",
		finalUrl: "https://example.com/",
		status: 200,
		contentType: "text/plain",
		body: new Uint8Array([1]),
		headers: { "content-type": "text/plain" },
	};
	expect(transcodeLegacyHtml(raw).encoding).toBeNull();
	expect(
		transcodeLegacyHtml({
			...raw,
			contentType: "text/html",
			headers: { "content-type": "text/html; charset=utf-8" },
		}).encoding,
	).toBeNull();
	const latin = transcodeLegacyHtml({
		...raw,
		contentType: "text/html",
		headers: { "content-type": 'text/html; charset="windows-1252"' },
		body: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
	});
	expect(latin.encoding).toBe("windows-1252");
	expect(
		transcodeLegacyHtml({
			...raw,
			contentType: "application/xhtml+xml",
			headers: {},
			body: new TextEncoder().encode('<meta charset="iso-8859-1"><p>plain</p>'),
		}).encoding,
	).toBe("iso-8859-1");
});

test("scope query stage requires a query and filter rejects empty in-scope sets", async () => {
	expect(() =>
		parseScope(
			JSON.stringify({
				decisions: [
					{
						id: "a",
						status: "in_scope",
						reason: "ok",
						question: "q",
						query: "   ",
					},
				],
			}),
			[{ id: "a", text: "a" }],
			"query",
		),
	).toThrow("SCOPED_QUERY_REQUIRED");
	await expect(
		filterResearchClaims(
			makeDetail({ claims: [makeClaim({ accepted: true })] }),
			{
				async complete() {
					return {
						text: JSON.stringify({
							decisions: [
								{
									id: "c1",
									status: "out_of_scope",
									reason: "no",
									question: "",
									query: "",
								},
							],
						}),
						usage: 1,
						audit: {},
					};
				},
			},
			signal,
		),
	).rejects.toThrow("NO_IN_SCOPE_CLAIMS");
	const many = await filterResearchClaims(
		makeDetail({
			claims: Array.from({ length: 13 }, (_, i) =>
				makeClaim({
					id: `c${i + 1}`,
					accepted: true,
					evidenceIds: i === 0 ? ["missing"] : ["ev-1"],
				}),
			),
		}),
		{
			async complete(_kind, input) {
				const items = JSON.parse(input).items as { id: string }[];
				return {
					text: JSON.stringify({
						decisions: items.map((item) => ({
							id: item.id,
							status: "in_scope",
							reason: "ok",
							question: "この知見は調査範囲か",
							query: "",
						})),
					}),
					usage: 1,
					audit: {},
				};
			},
		},
		signal,
	);
	expect(many.detail.claims.filter((c) => c.accepted)).toHaveLength(13);
});

test("budget holds differ for mock, live and memory versions", () => {
	const mock = makeJob({ mode: "mock" });
	expect(finalHold(mock).tokens).toBe(12000);
	const live = makeJob({
		mode: "live",
		config: { memoryVersion: 1, llmProvider: "codex" },
		budget: { ...makeJob().budget, tokens: 400000 },
	});
	expect(finalHold(live).requests).toBe(12);
	expect(evaluationHold(live).requests).toBe(10);
	const slim = makeJob({
		mode: "live",
		config: { memoryVersion: 0, llmProvider: "compatible" },
	});
	expect(evaluationHold(slim).requests).toBe(3);
	expect(fits(live, { tokens: 1 }, [finalHold(live)])).toBe(true);
	expect(
		fits(
			makeJob({ usage: { ...makeJob().usage, queries: 50 } }),
			{ queries: 1 },
			[],
		),
	).toBe(false);
});
