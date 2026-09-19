import { createHash } from "node:crypto";
import { z } from "zod";
import type { Artifact, Claim, Evidence, Snapshot } from "../contracts";
import { episodeSchema, knowledgeSchema } from "../memory/schema";
import { citationSchema, resolveCitations } from "./source-citations";
import { materializeDiscovery, mergeDiscovery } from "./world-model-discovery";
import { discoveryInputSchema } from "./world-model-schema";

export { citationSchema, sourceLines } from "./source-citations";

const text = z.string().trim().min(1);
const citations = z.array(citationSchema).min(1).max(12);
export const deliverableSection = z.object({
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
});
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
	sections: z.array(deliverableSection).max(10),
	knowledge: z.array(deliverableKnowledge).max(8),
	limitations: z.array(text.max(1200)).max(12),
	openQuestions: z.array(text.max(600)).max(8),
	worldModelDiscovery: discoveryInputSchema.nullable().optional(),
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
export const sectionUpdateSchema = z.object({
	sections: z
		.array(
			z.union([
				z.object({
					operation: z.literal("replace"),
					sectionId: text,
					section: deliverableSection,
				}),
				z.object({
					operation: z.literal("add"),
					afterSectionId: text.nullable(),
					section: deliverableSection,
				}),
				z.object({
					operation: z.literal("delete"),
					sectionId: text,
					reason: text.max(400),
				}),
			]),
		)
		.min(1)
		.max(6),
	knowledge: z.array(deliverableKnowledge).max(8),
	limitations: z.array(text.max(1200)).max(12),
	openQuestions: z.array(text.max(600)).max(8),
	worldModelDiscovery: discoveryInputSchema.nullable().optional(),
});
export const deliverableSectionStepSchema = z.object({
	update: sectionUpdateSchema,
	next: actionSchema,
});
export const deliverableEpisodeSchema = episodeSchema.omit({
	id: true,
	eventIds: true,
	claimIds: true,
});
export type Draft = z.infer<typeof draftSchema>;
export type SectionUpdate = z.infer<typeof sectionUpdateSchema>;
export type ResearchAction = z.infer<typeof actionSchema>;
export const stableId = (s: string) =>
	createHash("sha256").update(s).digest("hex").slice(0, 24);

export function draftSectionCatalog(draft: Draft) {
	const occurrences = new Map<string, number>();
	return draft.sections.map((section) => {
		const occurrence = occurrences.get(section.title) ?? 0;
		occurrences.set(section.title, occurrence + 1);
		return {
			sectionId: `s:${stableId(`${section.title}:${occurrence}`)}`,
			...section,
		};
	});
}

export function applySectionUpdate(draft: Draft, update: SectionUpdate): Draft {
	const catalog = draftSectionCatalog(draft);
	const originalIds = new Set(catalog.map((section) => section.sectionId));
	const targeted = new Set<string>();
	const sections = catalog.map(({ sectionId, ...section }) => ({
		sectionId,
		section,
	}));
	for (const operation of update.sections) {
		if (operation.operation === "add") {
			if (
				operation.afterSectionId !== null &&
				!originalIds.has(operation.afterSectionId)
			)
				throw Error("UNKNOWN_SECTION_REFERENCE");
			const index =
				operation.afterSectionId === null
					? -1
					: sections.findIndex(
							(section) => section.sectionId === operation.afterSectionId,
						);
			if (operation.afterSectionId !== null && index < 0)
				throw Error("SECTION_ALREADY_DELETED");
			sections.splice(index + 1, 0, {
				sectionId: `new:${stableId(JSON.stringify(operation.section))}`,
				section: operation.section,
			});
			continue;
		}
		if (!originalIds.has(operation.sectionId))
			throw Error("UNKNOWN_SECTION_REFERENCE");
		if (targeted.has(operation.sectionId))
			throw Error("DUPLICATE_SECTION_UPDATE");
		targeted.add(operation.sectionId);
		const index = sections.findIndex(
			(section) => section.sectionId === operation.sectionId,
		);
		if (index < 0) throw Error("SECTION_ALREADY_DELETED");
		if (operation.operation === "delete") sections.splice(index, 1);
		else sections[index] = { ...sections[index], section: operation.section };
	}
	const worldModelDiscovery = mergeDiscovery(
		draft.worldModelDiscovery ?? undefined,
		update.worldModelDiscovery,
	);
	return normalizeDraft(
		draftSchema.parse({
			sections: sections.map((entry) => entry.section),
			knowledge: update.knowledge,
			limitations: update.limitations,
			openQuestions: update.openQuestions,
			worldModelDiscovery,
		}),
	);
}

export function normalizeDraft(draft: Draft): Draft {
	const worldModelDiscovery = mergeDiscovery(
		undefined,
		draft.worldModelDiscovery,
	);
	if (worldModelDiscovery) return { ...draft, worldModelDiscovery };
	const { worldModelDiscovery: _omitted, ...rest } = draft;
	return rest;
}

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
		const ids = resolveCitations(cited, sources).map((item) => {
			if (!evidence.some((entry) => entry.id === item.id)) evidence.push(item);
			return item.id;
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
	const discoveryResult = materializeDiscovery(
		normalizeDraft(draft).worldModelDiscovery ?? undefined,
		sources,
		version,
	);
	for (const item of discoveryResult.evidence)
		if (!evidence.some((entry) => entry.id === item.id)) evidence.push(item);
	if (discoveryResult.discovery)
		artifact.worldModelDiscovery = discoveryResult.discovery;
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
