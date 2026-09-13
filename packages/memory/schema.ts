import { z } from "zod";
const text = z.string().trim().min(1).max(2400);
const strings = z.array(text).max(30);
const refs = z.array(z.string().min(1)).min(1).max(30);
export const knowledgeSchema = z.object({
	id: text,
	type: z.enum(["rule", "procedure"]),
	polarity: z.enum(["positive", "negative"]),
	title: text,
	body: z.string().trim().min(1).max(12000),
	skill: z
		.object({
			name: text,
			description: text,
			inputs: strings,
			outputs: strings,
			prerequisites: strings,
			failureHandling: strings,
		})
		.nullable()
		.optional(),
	appliesWhen: strings,
	notApplicableWhen: strings,
	steps: strings,
	verification: strings,
	unknowns: strings,
	claimIds: refs,
});
export const episodeSchema = z.object({
	id: text,
	title: text,
	context: text,
	intent: text,
	observations: text,
	decisions: strings,
	actionTaken: text,
	outcome: text,
	outcomeKind: z.enum(["success", "failure", "mixed", "unknown"]),
	failedApproach: strings,
	lesson: text,
	triggers: strings,
	openLoops: strings,
	eventIds: z.array(z.number().int().positive()).min(1).max(60),
	claimIds: z.array(z.string()).max(30),
});
export const conceptSchema = z.object({
	id: text,
	name: text,
	aliases: strings,
	description: text,
	claimIds: refs,
});
export const relationSchema = z.object({
	status: z.literal("suggested").optional(),
	from: text,
	to: text,
	type: z.enum([
		"supports",
		"contradicts",
		"applies_under",
		"requires",
		"step_of",
		"derived_from",
		"observed_in",
	]),
	conditions: strings,
	claimIds: refs,
});
export const memoryKnowledgeResponse = z.object({
	knowledge: z.array(knowledgeSchema).max(30),
});
export const memoryEpisodeResponse = z.object({
	episodes: z.array(episodeSchema).max(12),
});
export const memoryConceptResponse = z.object({
	concepts: z.array(conceptSchema).max(40),
	relations: z.array(relationSchema).max(60),
});
export const memoryReviewResponse = z.object({
	rechecks: z
		.array(z.object({ id: text, resolved: z.boolean(), reason: text }))
		.max(30)
		.optional(),
	scores: z.object({
		knowledge: z.number().min(0).max(100),
		episode: z.number().min(0).max(100),
		retrieval: z.number().min(0).max(100),
	}),
	defects: z
		.array(
			z.object({
				targetId: text,
				requirementId: text,
				reason: text,
				completionCriterion: text,
				route: z.enum([
					"revise_memory",
					"inspect_evidence",
					"research",
					"approval_pending",
					"supplement",
				]),
				critical: z.boolean(),
				claimIds: z.array(z.string()).max(30),
			}),
		)
		.max(30),
});
export type MemoryReview = z.infer<typeof memoryReviewResponse>;
export type MemoryKnowledge = z.infer<typeof knowledgeSchema>;
export type MemoryEpisode = z.infer<typeof episodeSchema>;
export interface MemoryBundle {
	id: string;
	schemaVersion: "memory-v1";
	inputHash: string;
	stageHashes?: Record<string, string>;
	objectMetadata?: Record<
		string,
		{
			schemaVersion: "memory-object-v1";
			researchRevision: number;
			contentHash?: string;
			inputHash: string;
			supersedes: string | null;
		}
	>;
	revision: number;
	asOf: string;
	jobId: string;
	topic: string;
	supersedes: string | null;
	events: import("../contracts").Event[];
	knowledge: MemoryKnowledge[];
	episodes: MemoryEpisode[];
	concepts: z.infer<typeof conceptSchema>[];
	relations: z.infer<typeof relationSchema>[];
	evidence: {
		claimId: string;
		text?: string;
		kind?: string;
		evidenceId: string;
		snapshotId: string;
		hash: string;
		url: string;
		start: number;
		end: number;
		unit: "utf16";
		quote: string;
	}[];
	review: MemoryReview | null;
	status: "draft" | "reviewed";
	structuralIssues: string[];
}
export const memorySchemas = {
	memory_knowledge: memoryKnowledgeResponse,
	memory_episode: memoryEpisodeResponse,
	memory_concepts: memoryConceptResponse,
	memory_review: memoryReviewResponse,
};
