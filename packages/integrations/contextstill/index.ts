import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { normalize } from "../../core";
export interface KnowledgeResult {
	items?: {
		id: string;
		title: string;
		body: string;
		lastVerifiedAt?: unknown;
	}[];
	state: "disconnected" | "known" | "verify" | "explore" | "unavailable";
	ids: string[];
	reason: string;
}
export interface KnowledgeProvider {
	lookup(query: string, signal: AbortSignal): Promise<KnowledgeResult>;
}
export const emptyKnowledge: KnowledgeProvider = {
	async lookup() {
		return {
			state: "disconnected",
			ids: [],
			reason: "ContextStill未接続。既知情報は未確認。",
		};
	},
};
// MCP handshake/session/SSE are handled by the SDK. Only the read-only search tool is called.
export class ContextStillMcp implements KnowledgeProvider {
	constructor(
		private endpoint: string,
		private apiKey = "",
		private request: typeof fetch = fetch,
	) {}
	async lookup(query: string, signal: AbortSignal): Promise<KnowledgeResult> {
		const client = new Client({ name: "deepstill", version: "0.1.0" });
		const transport = new StreamableHTTPClientTransport(
			new URL(this.endpoint),
			{
				fetch: this.request,
				requestInit: {
					headers: this.apiKey
						? { Authorization: `Bearer ${this.apiKey}` }
						: {},
				},
			},
		);
		try {
			await client.connect(transport, { signal, timeout: 10000 });
			const result = await client.callTool(
				{
					name: "search_knowledge",
					arguments: { query, limit: 5, statuses: ["active"] },
				},
				undefined,
				{ signal, timeout: 10000 },
			);
			if (result.isError) throw new Error("CONTEXT_TOOL");
			const blocks = z
				.array(z.object({ type: z.string(), text: z.string().optional() }))
				.parse(result.content);
			const block = blocks.find((c) => c.type === "text");
			const text = block?.type === "text" ? (block.text ?? "") : "";
			if (text.trim().toLowerCase() === "no content")
				return { state: "explore", ids: [], reason: "該当Knowledgeなし" };
			const data = z
				.object({
					items: z.array(
						z.object({
							id: z.string(),
							title: z.string(),
							body: z.string(),
							lastVerifiedAt: z.unknown().optional(),
						}),
					),
					diagnostics: z
						.object({ degradedReasons: z.array(z.unknown()).optional() })
						.optional(),
				})
				.parse(JSON.parse(text));
			if (data.diagnostics?.degradedReasons?.length)
				return {
					state: "unavailable",
					ids: data.items.map((i) => i.id),
					reason: "ContextStill degraded search",
				};
			const exact = data.items.some(
				(i) => normalize(i.title) === normalize(query),
			);
			return {
				state: exact ? "verify" : data.items.length ? "verify" : "explore",
				ids: data.items.map((i) => i.id),
				items: data.items,
				reason: exact
					? "同名Knowledgeあり。鮮度と根拠を外部資料で検証。"
					: data.items.length
						? "関連Knowledgeあり。差分を調査。"
						: "該当Knowledgeなし",
			};
		} catch {
			if (signal.aborted) throw signal.reason;
			return {
				state: "unavailable",
				ids: [],
				reason: "ContextStill接続または応答の確認に失敗",
			};
		} finally {
			await client.close().catch(() => {});
		}
	}
}
