import { z } from "zod";
import { type PromptKind, prompt } from "../prompts";
export interface LlmResult {
	text: string;
	usage: number | null;
	audit: unknown;
}
export interface LlmProvider {
	complete(
		kind: PromptKind,
		input: string,
		signal: AbortSignal,
	): Promise<LlmResult>;
}
export class CompatibleLlm implements LlmProvider {
	constructor(
		private base: string,
		private model: string,
		private apiKey: string,
		private request: typeof fetch = fetch,
	) {}
	async complete(kind: PromptKind, input: string, signal: AbortSignal) {
		const invocation = prompt(kind, input);
		const r = await this.request(
			`${this.base.replace(/\/$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.model,
					messages: [
						{ role: invocation.role, content: invocation.content.text },
					],
					temperature: 0,
					max_tokens: outputLimit(kind),
					stream: false,
				}),
				signal,
			},
		);
		if (!r.ok) throw new Error(`LLM_HTTP_${r.status}`);
		const data = z
			.object({
				choices: z
					.array(z.object({ message: z.object({ content: z.string() }) }))
					.min(1),
				usage: z.object({ total_tokens: z.number().nonnegative() }).optional(),
			})
			.parse(await r.json());
		return {
			text: data.choices[0].message.content,
			usage: data.usage?.total_tokens ?? null,
			audit: {
				manifest: invocation.manifest,
				role: invocation.role,
				content: invocation.content.text,
				model: this.model,
				temperature: 0,
				maxTokens: outputLimit(kind),
			},
		};
	}
}
export const fixtureLlm: LlmProvider = {
	async complete(kind, input) {
		const p = prompt(kind, input);
		const data = JSON.parse(input);
  if (kind.startsWith("memory_")) {
   const responses = {
    memory_knowledge: {knowledge:[]},
    memory_episode: {episodes:data.events.length ? [{id:"ep:research",title:data.topic,context:"Fixture research",intent:data.topic,observations:"Recorded search events",decisions:[],actionTaken:"Search and read recorded evidence",outcome:"Evidence collected; downstream use untested",outcomeKind:"unknown",failedApproach:[],lesson:"Check recorded evidence before reuse",triggers:[data.topic],openLoops:["Reuse not observed"],eventIds:data.events.map((e:{id:number})=>e.id).slice(-60),claimIds:[]}] : []},
    memory_concepts:{concepts:data.claims.map((c:{id:string;text:string},i:number)=>({id:`c:${i}`,name:c.text.slice(0,100),aliases:[],description:c.text,claimIds:[c.id]})),relations:[]},
    memory_review:{scores:{knowledge:95,episode:95,retrieval:95},defects:[]},
   };
   return {text:JSON.stringify(responses[kind as keyof typeof responses]),usage:120,audit:{fixture:true,notQualityEvidence:true}};
  }
		if (kind === "check_claims")
			return {
				text: JSON.stringify({
					decisions: data.claims.map((c: { id: string }) => ({
						id: c.id,
						selected: true,
						reason: "Fixture supported claim",
						priority: 50,
					})),
				}),
				usage: 120,
				audit: { fixture: true },
			};
		if (kind === "compress_claims")
			return {
				text: JSON.stringify({
					summaries: data.claims.map((c: { id: string; text: string }) => ({
						id: c.id,
						text: c.text.slice(0, 240),
						qualifications: "Fixture summary; full evidence retained",
					})),
				}),
				usage: 120,
				audit: { fixture: true },
			};
		if (kind === "prepare_brief")
			return {
				text: JSON.stringify({
					requirements: [
						{
							id: "main",
							text: data.originalRequest,
							required: true,
							origin: data.originalRequest,
							criterion: "Explain with evidence",
						},
					],
				}),
				usage: 120,
				audit: { fixture: true },
			};
		if (kind === "review_opportunities")
			return {
				text: JSON.stringify({
					decisions: data.opportunities.map(
						(o: { id: string; priority: number }) => ({
							id: o.id,
							selected: true,
							priority: o.priority,
							reason: "Fixture new information",
						}),
					),
				}),
				usage: 120,
				audit: { fixture: true },
			};
		if (kind === "select_sources")
			return {
				text: JSON.stringify({
					decisions: data.candidates.map((c: { id: string }, i: number) => ({
						id: c.id,
						selected: i < data.maxSelected,
						reason: "Relevant primary evidence",
						priority: 100 - i,
					})),
				}),
				usage: 120,
				audit: { fixture: true },
			};
		if (kind === "evaluate_round") {
			const ids = data.claims.map((c: { id: string }) => c.id);
			return {
				text: JSON.stringify({
					coverage: data.brief.requirements.map((r: { id: string }) => ({
						requirementId: r.id,
						status: ids.length ? "sufficient" : "missing",
						reason: "Fixture evidence coverage",
						claimIds: ids,
					})),
					sufficient: ids.length > 0,
					materialGaps: ids.length ? [] : ["No verified evidence"],
					contradictions: [],
					answerOutline: [],
					opportunities: [],
					recommendation: "finalize",
					reason: "No further valuable fixture candidate",
				}),
				usage: 120,
				audit: { fixture: true },
			};
		}
		return {
			text: JSON.stringify(
				kind === "extract"
					? {
							claims: data.passages.slice(0, 2).map((s: { text: string }) => ({
								text: s.text,
								quote: s.text,
								confidence: 1,
								relation: "supports",
							})),
							concepts: [],
						}
					: { claimIds: data.claims.map((c: { id: string }) => c.id) },
			),
			usage: 120,
			audit: {
				manifest: p.manifest,
				role: p.role,
				content: p.content.text,
				model: "fixture-v1",
			},
		};
	},
};
// UTF-8 bytes provide a conservative bound for the supported byte-tokenizing models.
// Hosts using another tokenizer must validate this bound before enabling live jobs.
export function tokenReservation(input: string, kind: PromptKind) {
	return (
		new TextEncoder().encode(prompt(kind, input).content.text).length +
		outputLimit(kind) +
		256
	);
}

export function outputLimit(kind: PromptKind) {
	return kind.startsWith("memory_") ? 4096 : kind === "synthesize" || kind === "edit"
		? 8192
		: kind === "evaluate_round"
			? 4096
			: 2048;
}
