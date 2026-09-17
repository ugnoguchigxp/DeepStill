import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { normalize } from "../../core";
import type {
	KnowledgeLookupContext,
	KnowledgeProvider,
	KnowledgeResult,
} from "../../knowledge-provider";
import {
	repositoryIdentitySchema,
	type RepositoryIdentity,
} from "../../repository-identity";

export interface ContextStillMcpOptions {
	repository?: RepositoryIdentity;
}

// MCP handshake/session/SSE are handled by the SDK. Only the read-only search tool is called.
export class ContextStillMcp implements KnowledgeProvider {
	private options: ContextStillMcpOptions;

	constructor(
		private endpoint: string,
		private apiKey = "",
		private request: typeof fetch = fetch,
		options: ContextStillMcpOptions = {},
	) {
		this.options = {
			repository:
				options.repository === undefined
					? undefined
					: repositoryIdentitySchema.parse(options.repository),
		};
	}

	async lookup(
		query: string,
		signal: AbortSignal,
		context: KnowledgeLookupContext = {},
	): Promise<KnowledgeResult> {
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
			const repository = context.repository
				? repositoryIdentitySchema.parse(context.repository)
				: this.options.repository;
			const result = await client.callTool(
				{
					name: "search_knowledge",
					arguments: {
						query,
						limit: 5,
						statuses: ["active"],
						...(repository?.projectRef
							? { projectRef: repository.projectRef }
							: {}),
						...(repository?.repoKey ? { repoKey: repository.repoKey } : {}),
						...(repository?.repoPath ? { repoPath: repository.repoPath } : {}),
					},
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
				return repository
					? {
							state: "unavailable",
							ids: [],
							reason: "ContextStill repository scope could not be verified",
						}
					: { state: "explore", ids: [], reason: "該当Knowledgeなし" };
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
						.object({
							degradedReasons: z.array(z.unknown()).optional(),
							scopedSearch: z.boolean().optional(),
							repoScopeFallbackUsed: z.boolean().optional(),
							missingIdentityGlobalOnly: z.boolean().optional(),
						})
						.optional(),
				})
				.parse(JSON.parse(text));
			if (
				repository &&
				(data.diagnostics?.scopedSearch !== true ||
					data.diagnostics.repoScopeFallbackUsed === true ||
					data.diagnostics.missingIdentityGlobalOnly === true)
			)
				return {
					state: "unavailable",
					ids: [],
					reason: "ContextStill repository scope could not be verified",
				};
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
