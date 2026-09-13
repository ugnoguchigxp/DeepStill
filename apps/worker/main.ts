import { DirectSearch } from "../../packages/search-provider/direct";
import { codeVersion, publishWorker } from "../../packages/runtime";
import type { Job } from "../../packages/contracts";
import { Store } from "../../packages/db";
import { Engine, mocks, type Providers } from "./engine";
import { DataForSeo } from "../../packages/search-provider";
import { liveCrawler } from "../../packages/crawler";
import {
	CodexLlm,
	configuredCodexModel,
} from "../../packages/llm-provider/codex";
import { CodexSearch } from "../../packages/search-provider/codex";
import { CompatibleLlm } from "../../packages/llm-provider";
import {
	ContextStillMcp,
	emptyKnowledge,
} from "../../packages/integrations/contextstill";
export function configuredProviders(job?: Job): Providers {
	return {
		search:
			job?.config.searchProvider === "direct"
				? new DirectSearch()
				: (job?.config.searchProvider ?? process.env.SEARCH_PROVIDER) ===
						"codex"
					? new CodexSearch()
					: new DataForSeo(
							process.env.DATAFORSEO_LOGIN || "",
							process.env.DATAFORSEO_PASSWORD || "",
							fetch,
							Number(
								job?.config.searchLocationCode ??
									process.env.DATAFORSEO_LOCATION_CODE ??
									2392,
							),
							String(
								job?.config.searchLanguageCode ??
									process.env.DATAFORSEO_LANGUAGE_CODE ??
									"ja",
							),
						),
		crawler: liveCrawler(),
		llm:
			(job?.config.llmProvider ?? process.env.LLM_PROVIDER) === "codex"
				? new CodexLlm(String(job?.config.llmModel ?? configuredCodexModel()))
				: new CompatibleLlm(
						String(
							job?.config.llmBaseUrl ??
								process.env.LLM_BASE_URL ??
								"http://127.0.0.1:8080/v1",
						),
						String(job?.config.llmModel ?? process.env.LLM_MODEL ?? ""),
						process.env.LLM_API_KEY || "",
					),
		knowledge: process.env.CONTEXTSTILL_MCP_URL
			? new ContextStillMcp(
					process.env.CONTEXTSTILL_MCP_URL,
					process.env.CONTEXTSTILL_API_KEY,
				)
			: emptyKnowledge,
	};
}
if (import.meta.main) {
	const store = new Store();
	if (!store.ready())
		throw new Error("Run bun run db:migrate before starting worker");
	const liveByJob = new Map<string, Providers>();
	const engine = new Engine(
		store,
		(j) => {
			if (j.mode === "mock") return mocks;
			let p = liveByJob.get(j.id);
			if (!p) {
				p = configuredProviders(j);
				liveByJob.set(j.id, p);
			}
			return p;
		},
		process.env.ARTIFACT_ROOT || "data/artifacts",
	);
	const version = codeVersion();
	publishWorker(store.path, version);
	const healthTimer = setInterval(
		() => publishWorker(store.path, version),
		2000,
	);
	const shutdown = new AbortController();
	let stopping = false;
	process.on("SIGINT", () => {
		stopping = true;
		shutdown.abort(new Error("WORKER_SHUTDOWN"));
	});
	process.on("SIGTERM", () => {
		stopping = true;
		shutdown.abort(new Error("WORKER_SHUTDOWN"));
	});
	console.info(JSON.stringify({ event: "worker.started" }));
	while (!stopping) {
		try {
			if (!(await engine.tick(undefined, shutdown.signal)))
				await Bun.sleep(250);
			for (const [id, p] of liveByJob) {
				if (
					!store.getJob(id) ||
					["completed", "partial", "failed", "cancelled"].includes(
						store.getJob(id)?.status ?? "",
					)
				) {
					await p.crawler.close();
					liveByJob.delete(id);
				}
			}
		} catch (e) {
			console.error(
				JSON.stringify({
					event: "worker.error",
					error: e instanceof Error ? e.message : "UNKNOWN",
				}),
			);
			await Bun.sleep(1000);
		}
	}
	for (const p of liveByJob.values()) await p.crawler.close();
	clearInterval(healthTimer);
	store.close();
}
