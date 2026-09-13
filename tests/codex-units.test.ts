import { expect, test, vi } from "vitest";

let receivedThread: Record<string, unknown> = {};
let receivedConfig: Record<string, unknown> = {};
let response = '{"suggestions":["foundation query one"]}';
let items: { type: string }[] = [{ type: "agent_message" }];
let usage: { input_tokens: number; output_tokens: number } | undefined = {
	input_tokens: 2,
	output_tokens: 3,
};

vi.mock("@openai/codex-sdk", () => ({
	Codex: class {
		constructor(options: { config: Record<string, unknown> }) {
			receivedConfig = options.config;
		}
		startThread(options: Record<string, unknown>) {
			receivedThread = options;
			return {
				id: "thread-1",
				run: async () => ({
					finalResponse: response,
					usage,
					items,
				}),
			};
		}
	},
}));

import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSearch } from "../packages/search-provider/codex";
import {
	CodexLlm,
	groundedSchema,
	runCodex,
	strictSchema,
} from "../packages/llm-provider/codex";
import { inspectCodex } from "../packages/llm-provider/runtime";

const signal = new AbortController().signal;

test("groundedSchema binds ids for direction, memory, extract and report kinds", () => {
	const direction = groundedSchema(
		"research_direction_review",
		JSON.stringify({
			completedWorkIds: ["w1"],
			sources: [{ snapshotId: "src-1" }],
		}),
	);
	expect(direction).toBeTruthy();
	expect(
		groundedSchema(
			"research_direction_review",
			JSON.stringify({ completedWorkIds: [], sources: [] }),
		),
	).toBeTruthy();
	expect(groundedSchema("research_action_select", "{}")).toBeTruthy();
	expect(groundedSchema("source_range_select", "{}")).toBeTruthy();
	expect(groundedSchema("memory_retrieve", "{}")).toBeTruthy();
	expect(groundedSchema("memory_probe", "{}")).toBeTruthy();
	expect(groundedSchema("memory_judge", "{}")).toBeTruthy();
	expect(groundedSchema("compress_claims", "{}")).toBeTruthy();
	expect(groundedSchema("prepare_brief", "{}")).toBeTruthy();
	expect(groundedSchema("select_sources", "{}")).toBeTruthy();
	expect(groundedSchema("evaluate_round", "{}")).toBeTruthy();
	expect(groundedSchema("scope", "{}")).toBeTruthy();
	expect(groundedSchema("review", "{}")).toBeTruthy();
	const memory = groundedSchema(
		"memory_review",
		JSON.stringify({
			generationVersion: 2,
			gaps: [{ id: "gap-1" }],
			claims: [{ id: "c1" }],
			events: [{ id: 1 }],
			brief: { requirements: [{ id: "main" }] },
			memory: {
				knowledge: [{ id: "k:1" }],
				episodes: [{ id: "ep:1" }],
				concepts: [{ id: "c:1" }],
			},
		}),
	);
	expect(memory).toBeTruthy();
	expect(
		groundedSchema(
			"memory_knowledge",
			JSON.stringify({ claims: [], events: [], gaps: [] }),
		),
	).toBeTruthy();
	expect(
		groundedSchema(
			"extract",
			JSON.stringify({ existingClaims: [{ id: "c1" }] }),
		),
	).toBeTruthy();
	expect(
		groundedSchema("synthesize", JSON.stringify({ claims: [{ id: "c1" }] })),
	).toBeTruthy();
	expect(strictSchema(["a", null, 1])).toEqual(["a", null, 1]);
});

test("runCodex and Codex adapters honor web search, tools and usage", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
	const bin = join(dir, "codex");
	writeFileSync(bin, "#!/bin/sh\necho '1.0.0'\n");
	writeFileSync(
		join(dir, "config.toml"),
		'[mcp_servers.foo]\ncommand = "false"\n[plugins.sample]\nenabled = true\n',
	);
	const previousPath = process.env.CODEX_PATH;
	const previousHome = process.env.CODEX_HOME;
	process.env.CODEX_PATH = bin;
	process.env.CODEX_HOME = dir;
	try {
		response = JSON.stringify({ suggestions: ["foundation query one"] });
		items = [{ type: "agent_message" }];
		const search = new CodexSearch();
		expect((await runCodex("usage probe", signal)).tokenUsage).toEqual({
			inputTokens: 2,
			outputTokens: 3,
		});
		expect((await search.suggest("topic", signal)).suggestions[0]).toContain(
			"foundation",
		);
		expect((await search.submit("topic", signal)).id).toBe("topic");
		items = [{ type: "web_search" }];
		response = JSON.stringify({
			hits: [
				{
					url: "https://example.org/paper",
					title: "Paper",
					snippet: "Evidence",
					rank: 1,
				},
			],
		});
		expect((await search.poll("topic", signal)).ready).toBe(true);
		items = [{ type: "agent_message" }];
		await expect(search.poll("topic", signal)).rejects.toThrow(
			"SEARCH_NOT_EXECUTED",
		);
		items = [{ type: "mcp_tool_call" }];
		await expect(runCodex("hi", signal)).rejects.toThrow(
			"UNEXPECTED_CODEX_TOOL_USE",
		);
		items = [{ type: "agent_message" }];
		usage = undefined;
		response = '{"ok":true}';
		const llm = new CodexLlm("gpt-5.6-terra");
		const result = await llm.complete(
			"scope",
			JSON.stringify({ items: [] }),
			signal,
		);
		expect(result.usage).toBeNull();
		expect(receivedThread.model).toBe("gpt-5.6-terra");
		expect(receivedThread.modelReasoningEffort).toBe("low");
		expect(result.audit.model).toBe("gpt-5.6-terra");
		expect(receivedConfig.mcp_servers).toEqual({ foo: { enabled: false } });
		expect(receivedConfig.plugins).toEqual({ sample: { enabled: false } });
		expect(receivedConfig.features).toMatchObject({
			apps: false,
			memories: false,
			shell_tool: false,
		});
		expect(receivedConfig.skills).toMatchObject({
			include_instructions: false,
		});
	} finally {
		if (previousPath === undefined) delete process.env.CODEX_PATH;
		else process.env.CODEX_PATH = previousPath;
		if (previousHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspectCodex accepts a current CLI and rejects an old one", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-bin-"));
	const ok = join(dir, "ok");
	const old = join(dir, "old");
	const fail = join(dir, "fail");
	writeFileSync(ok, "#!/bin/sh\necho 'codex-cli 0.200.0'\n");
	writeFileSync(old, "#!/bin/sh\necho '0.100.0'\n");
	writeFileSync(fail, "#!/bin/sh\nexit 1\n");
	chmodSync(ok, 0o755);
	chmodSync(old, 0o755);
	chmodSync(fail, 0o755);
	const previous = process.env.CODEX_PATH;
	try {
		process.env.CODEX_PATH = ok;
		expect(inspectCodex().ready).toBe(true);
		process.env.CODEX_PATH = old;
		expect(inspectCodex().error).toBe("CODEX_CLI_TOO_OLD");
		process.env.CODEX_PATH = fail;
		expect(inspectCodex().ready).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.CODEX_PATH;
		else process.env.CODEX_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh evidence requires a draft while navigation has a compact null schema", () => {
	const fresh = groundedSchema(
		"deliverable_step",
		JSON.stringify({ newContent: { lines: [] } }),
	) as unknown as { properties: { draft: { type: string } } };
	const nav = groundedSchema(
		"deliverable_step",
		JSON.stringify({ navigationOnly: true }),
	) as unknown as { properties: { draft: { type: string } } };
	expect(fresh.properties.draft.type).toBe("object");
	expect(nav.properties.draft.type).toBe("null");
});

test("navigation schema only permits unread source IDs and removes read when exhausted", () => {
	const withUnread = groundedSchema(
		"deliverable_step",
		JSON.stringify({ navigationOnly: true, readableSourceIds: ["unread"] }),
	);
	const without = groundedSchema(
		"deliverable_step",
		JSON.stringify({ navigationOnly: true, readableSourceIds: [] }),
	);
	const text = JSON.stringify(withUnread);
	expect(text).toContain('"enum":["unread"]');
	expect(JSON.stringify(without)).not.toContain('"const":"read"');
});

test("incremental writing schema cannot replace the entire draft", () => {
	const schema = groundedSchema(
		"deliverable_step",
		JSON.stringify({
			incrementalUpdate: true,
			draft: { sections: [], knowledge: [] },
			newContent: { sourceId: "s" },
		}),
	) as unknown as {
		properties: {
			draft: { type: string };
			update: { properties: { replaceSections: unknown } };
		};
	};
	expect(schema.properties.draft.type).toBe("null");
	expect(schema.properties.update.properties.replaceSections).toBeDefined();
});
