import { duckDuckGo } from "llm-fetch";
import type { SearchProvider } from "./index";
import { SearchProviderError } from "./index";
/** Engine search results without an LLM rewriting or selecting them. */
export class DirectSearch implements SearchProvider {
	constructor(private provider = duckDuckGo()) {}
	async suggest() {
		return { suggestions: [], cost: 0 };
	}
	async submit(query: string) {
		return { id: query, cost: 0 };
	}
	async poll(id: string, signal: AbortSignal) {
		try {
			const hits = await this.provider.search({
				query: id,
				limit: 8,
				language: "ja",
				region: "JP",
				signal,
			});
			return { ready: true, hits, cost: 0, usage: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : "SEARCH_FAILED";
			throw new SearchProviderError(
				message,
				/timed? out|timeout|temporar|econnreset|network|fetch failed/i.test(
					message,
				),
			);
		}
	}
}
