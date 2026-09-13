import { expect, test } from "vitest";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredProviders } from "../apps/worker/main";
import { requireWorker, waitResearch } from "../packages/runtime/research-cli";
import { Store } from "../packages/db";
import { createJobSchema } from "../packages/contracts";
import { codeVersion, publishWorker } from "../packages/runtime";
import { CodexSearch } from "../packages/search-provider/codex";
import { CodexLlm } from "../packages/llm-provider/codex";
import { DataForSeo } from "../packages/search-provider";
import { CompatibleLlm } from "../packages/llm-provider";

test("configuredProviders selects Codex or DataForSEO from env and job config", () => {
	const previous = {
		SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
		LLM_PROVIDER: process.env.LLM_PROVIDER,
		CONTEXTSTILL_MCP_URL: process.env.CONTEXTSTILL_MCP_URL,
		DATAFORSEO_LOGIN: process.env.DATAFORSEO_LOGIN,
		DATAFORSEO_PASSWORD: process.env.DATAFORSEO_PASSWORD,
		LLM_MODEL: process.env.LLM_MODEL,
	};
	try {
		process.env.SEARCH_PROVIDER = "codex";
		process.env.LLM_PROVIDER = "codex";
		delete process.env.CONTEXTSTILL_MCP_URL;
		const codex = configuredProviders();
		expect(codex.search).toBeInstanceOf(CodexSearch);
		expect(codex.llm).toBeInstanceOf(CodexLlm);
		process.env.SEARCH_PROVIDER = "dataforseo";
		process.env.LLM_PROVIDER = "compatible";
		process.env.DATAFORSEO_LOGIN = "a";
		process.env.DATAFORSEO_PASSWORD = "b";
		process.env.LLM_MODEL = "test";
		process.env.CONTEXTSTILL_MCP_URL = "http://127.0.0.1:9";
		const live = configuredProviders();
		expect(live.search).toBeInstanceOf(DataForSeo);
		expect(live.llm).toBeInstanceOf(CompatibleLlm);
		const job = {
			config: { searchProvider: "codex", llmProvider: "codex" },
		} as unknown as Parameters<typeof configuredProviders>[0];
		const fromJob = configuredProviders(job);
		expect(fromJob.search).toBeInstanceOf(CodexSearch);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("research CLI requires a live worker and returns when the job is already terminal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cli-"));
	const store = new Store(join(dir, "db.sqlite"));
	store.migrate();
	try {
		expect(() => requireWorker(store)).toThrow("WORKER_REQUIRED");
		const job = store.create(createJobSchema.parse({ topic: "cli job" }));
		await expect(waitResearch(store, job.id)).rejects.toThrow(
			"WORKER_UNAVAILABLE",
		);
		publishWorker(store.path, codeVersion());
		const completed = store.getJob(job.id);
		if (!completed) throw new Error("missing");
		completed.status = "completed";
		store.saveJob(completed);
		await waitResearch(store, job.id);
		requireWorker(store);
		const running = store.create(
			createJobSchema.parse({ topic: "cli running" }),
		);
		running.status = "running";
		store.saveJob(running);
		store.event(running.id, "job.started", { note: "wait" });
		const pending = waitResearch(store, running.id);
		running.status = "completed";
		store.saveJob(running);
		await pending;
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspect-style helper binaries are executable", () => {
	const dir = mkdtempSync(join(tmpdir(), "bin-"));
	const path = join(dir, "tool");
	writeFileSync(path, "#!/bin/sh\necho ok\n");
	chmodSync(path, 0o755);
	rmSync(dir, { recursive: true, force: true });
});
