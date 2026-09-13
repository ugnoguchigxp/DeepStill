import { locateEvidence } from "../core";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Artifact, Claim, Evidence, Snapshot } from "../contracts";
import { episodeSchema, knowledgeSchema } from "../memory/schema";

const text = z.string().trim().min(1);
export const citationSchema = z.union([
	z.object({
		sourceId: text,
		firstLine: z.number().int().positive(),
		lastLine: z.number().int().positive(),
	}),
	z.object({ sourceId: text, quote: text.max(4000) }),
]);
export function sourceLines(text: string) {
	const result: { number: number; start: number; end: number; text: string }[] =
		[];
	let start = 0,
		end = 0,
		bytes = 0;
	for (const char of text) {
		end += char.length;
		bytes += Buffer.byteLength(char);
		if (char === "\n" || bytes >= 1200) {
			result.push({
				number: result.length + 1,
				start,
				end,
				text: text.slice(start, end),
			});
			start = end;
			bytes = 0;
		}
	}
	if (end > start)
		result.push({
			number: result.length + 1,
			start,
			end,
			text: text.slice(start, end),
		});
	return result;
}
const citations = z.array(citationSchema).min(1).max(12);
export const skillSchema = z.object({
	name: text.max(100),
	description: text.max(500),
	inputs: z.array(text).min(1),
	outputs: z.array(text).min(1),
	prerequisites: z.array(text).min(1),
	failureHandling: z.array(text).min(1),
});
export const deliverableKnowledge = knowledgeSchema
	.omit({ id: true, claimIds: true })
	.extend({
		body: text.max(12000),
		citations,
		skill: skillSchema.nullable(),
	});
export const draftSchema = z.object({
	sections: z
		.array(
			z.object({
				title: text.max(200),
				paragraphs: z
					.array(
						z.object({
							text: text.max(2400),
							kind: z.enum(["finding", "inference"]),
							citations,
						}),
					)
					.min(1)
					.max(8),
			}),
		)
		.max(10),
	knowledge: z.array(deliverableKnowledge).max(8),
	limitations: z.array(text.max(1200)).max(12),
	openQuestions: z.array(text.max(600)).max(8),
});
export const actionSchema = z.union([
	z.object({ kind: z.literal("read"), sourceId: text, purpose: text.max(400) }),
	z.object({ kind: z.literal("fetch"), url: text, purpose: text.max(400) }),
	z.object({
		kind: z.literal("search"),
		query: text.max(300),
		purpose: text.max(400),
	}),
	z.object({
		kind: z.literal("finish"),
		satisfied: z.boolean(),
		reason: text.max(600),
	}),
]);
export const deliverableStepSchema = z.object({
	draft: draftSchema.nullable(),
	next: actionSchema,
});
export const deliverableEpisodeSchema = episodeSchema.omit({
	id: true,
	eventIds: true,
	claimIds: true,
});
export type Draft = z.infer<typeof draftSchema>;
export type ResearchAction = z.infer<typeof actionSchema>;
export const stableId = (s: string) =>
	createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Citations are attached directly to user-visible paragraphs/knowledge; no LLM claim extraction. */
export function materialize(
	draft: Draft,
	sources: Snapshot[],
	jobId: string,
	version: number,
	topic: string,
) {
	const claims: Claim[] = [],
		evidence: Evidence[] = [];
	const refs = (body: string, cited: z.infer<typeof citations>) => {
		const ids = cited.map((c) => {
			const source = sources.find((s) => s.id === c.sourceId);
			if (
				!source ||
				createHash("sha256").update(source.text).digest("hex") !== source.hash
			)
				throw Error("INVALID_SOURCE_REFERENCE");
			let located: ReturnType<typeof locateEvidence>;
			try {
				if ("quote" in c) located = locateEvidence(source, c.quote);
				else {
					const lines = sourceLines(source.text),
						first = lines[c.firstLine - 1],
						last = lines[c.lastLine - 1];
					if (!first || !last || last.end <= first.start)
						throw Error("INVALID_LINE_REFERENCE");
					located = {
						start: first.start,
						end: last.end,
						quote: source.text.slice(first.start, last.end),
						context: source.text.slice(
							Math.max(0, first.start - 120),
							last.end + 120,
						),
					};
				}
			} catch {
				throw Error(
					`QUOTE_NOT_IN_SNAPSHOT: ${source.id}: ${JSON.stringify(c).slice(0, 350)}. Copy a contiguous passage without ellipses.`,
				);
			}
			const id = `e:${stableId(`${source.id}:${located.start}:${located.quote}`)}`;
			if (!evidence.some((e) => e.id === id))
				evidence.push({ id, snapshotId: source.id, ...located });
			return id;
		});
		const id = `c:${stableId(JSON.stringify([body, ids]))}`;
		if (!claims.some((c) => c.id === id))
			claims.push({
				id,
				text: body,
				evidenceIds: ids,
				confidence: 0.8,
				kind: "NEW",
				accepted: true,
				reason:
					"成果物に付随する引用の原文一致を検証（独立した意味審査ではない）",
				relatedClaimIds: [],
			});
		return [id];
	};
	const sections = draft.sections.map((s) => ({
		title: s.title,
		paragraphs: s.paragraphs.map((p) => ({
			text: p.text,
			kind: p.kind,
			claimIds: refs(p.text, p.citations),
		})),
	}));
	const knowledge = draft.knowledge.map((k) => {
		if (
			k.type === "procedure" &&
			(!k.skill ||
				k.steps.length < 2 ||
				!k.verification.length ||
				!k.appliesWhen.length)
		)
			throw Error("INCOMPLETE_SKILL");
		if (k.type !== "procedure" && k.skill)
			throw Error("SKILL_REQUIRES_PROCEDURE");
		const { citations, ...fields } = k;
		return {
			...fields,
			id: `k:${stableId(k.title)}`,
			claimIds: refs(k.body, citations),
		};
	});
	const artifact: Artifact = {
		id: `deliverable:${jobId}:${version}`,
		version,
		title: topic,
		body: sections
			.map(
				(s) => `${s.title}\n\n${s.paragraphs.map((p) => p.text).join("\n\n")}`,
			)
			.join("\n\n"),
		sections,
		claimIds: [
			...new Set(
				sections.flatMap((s) => s.paragraphs.flatMap((p) => p.claimIds)),
			),
		],
		limitations: draft.limitations,
		openQuestions: draft.openQuestions,
		generatedAt: new Date().toISOString(),
		fixture: false,
	};
	if (!sections.length) {
		delete artifact.sections;
		artifact.evidenceUnavailable = true;
		artifact.body = "根拠に基づく説明をレポートに保存できませんでした。";
		if (!artifact.limitations?.length)
			artifact.limitations = [
				"引用付きの説明が保存されていません。取得・読解の成否は実行履歴を確認してください。",
			];
	}
	return { artifact, knowledge, claims, evidence };
}
export function skillName(name: string) {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 63)
		.replace(/-$/g, "");
	return slug || `research-${stableId(name)}`;
}
export function skillMarkdown(k: z.infer<typeof deliverableKnowledge>) {
	if (!k.skill || k.type !== "procedure") throw Error("INCOMPLETE_SKILL");
	return (
		`---\nname: ${JSON.stringify(skillName(k.skill.name))}\ndescription: ${JSON.stringify(k.skill.description)}\n---\n\n# ${k.title}\n\n${k.body}\n\n` +
		Object.entries({
			適用条件: k.appliesWhen,
			適用しない条件: k.notApplicableWhen,
			入力: k.skill.inputs,
			出力: k.skill.outputs,
			前提: k.skill.prerequisites,
			手順: k.steps,
			完了確認: k.verification,
			失敗時の対応: k.skill.failureHandling,
			未確認: k.unknowns,
		})
			.map(
				([label, items]) =>
					`## ${label}\n\n${items.map((t, i) => (label === "手順" ? `${i + 1}. ${t}` : `- ${t}`)).join("\n")}\n`,
			)
			.join("\n")
	);
}
