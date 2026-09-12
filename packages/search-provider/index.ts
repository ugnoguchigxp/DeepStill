import { z } from "zod";
import type { Hit } from "../contracts";
export interface SearchContext {
	topic: string;
	sources: { url: string; title: string }[];
	failures: { url: string; reason: string }[];
}
export interface SearchProvider {
	suggest(
		query: string,
		signal: AbortSignal,
	): Promise<{ suggestions: string[]; cost: number }>;
	submit(
		query: string,
		signal: AbortSignal,
	): Promise<{ id: string; cost: number }>;
	poll(
		id: string,
		signal: AbortSignal,
		context?: SearchContext,
	): Promise<{ ready: boolean; hits: Hit[]; cost: number }>;
}
const responseSchema = z.object({
	status_code: z.number(),
	cost: z.number().optional(),
	tasks: z.array(
		z.object({
			id: z.string().optional(),
			status_code: z.number(),
			cost: z.number().optional(),
			result: z
				.array(
					z
						.object({
							items: z
								.array(
									z
										.object({
											type: z.string(),
											suggestion: z.string().optional(),
											url: z.string().optional(),
											title: z.string().nullable().optional(),
											description: z.string().nullable().optional(),
											rank_absolute: z.number().optional(),
										})
										.passthrough(),
								)
								.nullable()
								.optional(),
						})
						.passthrough(),
				)
				.nullable()
				.optional(),
		}),
	),
});
export class SearchProviderError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}
export class DataForSeo implements SearchProvider {
	constructor(
		private login: string,
		private password: string,
		private request: typeof fetch = fetch,
		private locationCode = Number(process.env.DATAFORSEO_LOCATION_CODE || 2392),
		private languageCode = process.env.DATAFORSEO_LANGUAGE_CODE || "ja",
	) {}
	async call(path: string, body: unknown, signal: AbortSignal) {
		const r = await this.request(
			`https://api.dataforseo.com/v3/serp/google/${path}`,
			{
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Basic ${btoa(`${this.login}:${this.password}`)}`,
					"Content-Type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
				signal,
			},
		);
		if (!r.ok)
			throw new SearchProviderError(
				`SEARCH_HTTP_${r.status}`,
				r.status === 429 || r.status >= 500,
			);
		const value = responseSchema.parse(await r.json());
		if (value.status_code !== 20000)
			throw new Error(`SEARCH_STATUS_${value.status_code}`);
		const task = value.tasks[0];
		if (!task) throw new Error("SEARCH_EMPTY_TASK");
		return { task, cost: value.cost ?? task.cost ?? 0 };
	}
	params(query: string) {
		return {
			keyword: query,
			language_code: this.languageCode,
			location_code: this.locationCode,
		};
	}
	async suggest(query: string, signal: AbortSignal) {
		const { task, cost } = await this.call(
			"autocomplete/live/advanced",
			[{ ...this.params(query), client: "gws-wiz-serp" }],
			signal,
		);
		if (task.status_code !== 20000)
			throw new Error(`SEARCH_STATUS_${task.status_code}`);
		return {
			cost,
			suggestions: (task.result ?? [])
				.flatMap((r) => r.items ?? [])
				.filter((i) => i.type === "autocomplete" && i.suggestion)
				.map((i) => i.suggestion as string),
		};
	}
	async submit(query: string, signal: AbortSignal) {
		const { task, cost } = await this.call(
			"organic/task_post",
			[{ ...this.params(query), depth: 10 }],
			signal,
		);
		if (task.status_code !== 20100 || !task.id)
			throw new Error(`SEARCH_STATUS_${task.status_code}`);
		return { id: task.id, cost };
	}
	async poll(id: string, signal: AbortSignal) {
		const { task, cost } = await this.call(
			`organic/task_get/advanced/${encodeURIComponent(id)}`,
			null,
			signal,
		);
		if ([20100, 40601, 40602].includes(task.status_code))
			return { ready: false, hits: [], cost };
		if (task.status_code !== 20000)
			throw new Error(`SEARCH_STATUS_${task.status_code}`);
		return {
			ready: true,
			cost,
			hits: (task.result ?? [])
				.flatMap((r) => r.items ?? [])
				.filter((i) => i.type === "organic" && i.url)
				.map((i) => ({
					url: i.url as string,
					title: i.title ?? "",
					snippet: i.description ?? "",
					rank: i.rank_absolute ?? 100,
				})),
		};
	}
}
export const fixtureSearch: SearchProvider = {
	async suggest(q) {
		return { cost: 0, suggestions: [`${q} architecture`, `${q} evidence`, q] };
	},
	async submit(q) {
		return { id: q, cost: 0 };
	},
	async poll() {
		return {
			ready: true,
			cost: 0,
			hits: [
				{
					url: "https://fixture.example/research",
					title: "Research fixture",
					snippet: "Immutable evidence snapshots and bounded research.",
					rank: 1,
				},
				{
					url: "https://fixture.example/limits",
					title: "Budget fixture",
					snippet: "Durable task leases and hard budgets.",
					rank: 2,
				},
			],
		};
	},
};
