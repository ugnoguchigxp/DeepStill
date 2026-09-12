import { memorySchemas } from "../memory/schema";
import { summariesSchema } from "../research/rounds";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { reviewSchema } from "../artifact/quality";
import { claimResponse, reportResponse } from "../contracts";
import { type PromptKind, prompt } from "../prompts";
import {
	briefSchema,
	evaluationSchema,
	selectionSchema,
} from "../research/rounds";
import { scopeResponse } from "../research/scope";
import type { LlmProvider } from "./index";
import { resolveCodexPath } from "./runtime";

export function strictSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(strictSchema);
	if (!schema || typeof schema !== "object") return schema;
	const value = Object.fromEntries(
		Object.entries(schema)
			.filter(
				([key, item]) =>
					key !== "default" &&
					key !== "$schema" &&
					!(key === "format" && item === "uri"),
			)
			.map(([key, item]) => [key, strictSchema(item)]),
	);
	if (value.type === "object" && value.properties) {
		value.required = Object.keys(value.properties);
		value.additionalProperties = false;
	}
	return value;
}
export function groundedSchema(kind: PromptKind, input: string) {
 if (kind in memorySchemas) return z.toJSONSchema(memorySchemas[kind as keyof typeof memorySchemas]);
	if (kind === "compress_claims") return z.toJSONSchema(summariesSchema);
	if (kind === "prepare_brief") return z.toJSONSchema(briefSchema);
	if (
		kind === "select_sources" ||
		kind === "check_claims" ||
		kind === "review_opportunities"
	)
		return z.toJSONSchema(selectionSchema);
	if (kind === "evaluate_round") return z.toJSONSchema(evaluationSchema);
	if (kind === "scope") return z.toJSONSchema(scopeResponse);
	if (kind === "review") return z.toJSONSchema(reviewSchema);
	const data = JSON.parse(input);
	const ids = (
		kind === "extract" ? data.existingClaims || [] : data.claims || []
	).map((c: { id: string }) => c.id);
	const schema = z.toJSONSchema(
		kind === "extract" ? claimResponse : reportResponse,
	);
	const walk = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		const properties = object.properties as
			| Record<string, Record<string, unknown>>
			| undefined;
		if (properties?.claimIds && (kind === "synthesize" || kind === "edit"))
			properties.claimIds.items = { type: "string", enum: ids };
		if (properties?.relatedClaimId && kind === "extract")
			properties.relatedClaimId = { type: "string", enum: ["", ...ids] };
		for (const child of Object.values(object)) walk(child);
	};
	walk(schema);
	return schema;
}
export const CODEX_MODEL = "gpt-5.6-luna";
export const CODEX_REASONING = "low";
/** Each call has a fresh, empty workspace and no inherited project instructions. */
export async function runCodex(
	input: string,
	signal: AbortSignal,
	options: { web?: boolean; schema?: unknown } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "deepstill-codex-"));
	try {
		const configFile = Bun.file(
			join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
		);
		const inherited = (await configFile.exists())
			? (Bun.TOML.parse(await configFile.text()) as {
					mcp_servers?: Record<string, unknown>;
				})
			: {};
		const disabledMcp = Object.fromEntries(
			Object.keys(inherited.mcp_servers || {}).map((name) => [
				name,
				{ enabled: false },
			]),
		);
		const codex = new Codex({
			codexPathOverride: resolveCodexPath(),
			config: {
				shell_environment_policy: { inherit: "none" },
				features: { shell_tool: false },
				mcp_servers: disabledMcp,
				developer_instructions:
					"You are a stateless research processor. Never use MCP tools, skills, local files or shell commands. Only use the supplied research input. Web search is allowed only when explicitly requested by the user prompt.",
				project_doc_max_bytes: 0,
			},
		});
		const thread = codex.startThread({
			model: CODEX_MODEL,
			modelReasoningEffort: CODEX_REASONING,
			workingDirectory: directory,
			skipGitRepoCheck: true,
			sandboxMode: "read-only",
			approvalPolicy: "never",
			networkAccessEnabled: false,
			webSearchMode: options.web ? "live" : "disabled",
		});
		const turn = await thread.run(input, {
			signal,
			outputSchema: options.schema ? strictSchema(options.schema) : undefined,
		});
		if (
			turn.items.some((item) =>
				["mcp_tool_call", "command_execution", "file_change"].includes(
					item.type,
				),
			)
		)
			throw new Error("UNEXPECTED_CODEX_TOOL_USE");
		return {
			text: turn.finalResponse,
			usage: turn.usage
				? turn.usage.input_tokens + turn.usage.output_tokens
				: null,
			audit: {
				provider: "codex-sdk",
				model: CODEX_MODEL,
				reasoning: CODEX_REASONING,
				threadId: thread.id,
				usage: turn.usage,
				webSearch: !!options.web,
				items: turn.items,
			},
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
export class CodexLlm implements LlmProvider {
	async complete(kind: PromptKind, input: string, signal: AbortSignal) {
		const invocation = prompt(kind, input);
		const result = await runCodex(invocation.content.text, signal, {
			schema: groundedSchema(kind, input),
		});
		return {
			...result,
			audit: {
				...result.audit,
				manifest: invocation.manifest,
				content: invocation.content.text,
			},
		};
	}
}
