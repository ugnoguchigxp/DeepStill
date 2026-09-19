import { z } from "zod";
import type { ResearchState } from "../research/rounds";
const budgetFields = z.object({
	rounds: z.number().int().min(1).max(50).default(6),
	queries: z.number().int().min(1).max(500).default(50),
	urls: z.number().int().min(1).max(1000).default(100),
	documents: z.number().int().min(1).max(100).default(20),
	tokens: z.number().int().min(4096).max(1100000).default(100000),
	inputTokens: z.number().int().min(4096).max(1000000).optional(),
	outputTokens: z.number().int().min(1024).max(100000).optional(),
	requests: z.number().int().min(1).max(2000).default(200),
	costUsd: z.number().positive().max(100).default(5),
	depth: z.number().int().min(0).max(10).default(5),
	wallMs: z.number().int().min(1000).max(7200000).default(7200000),
});
// Explicit legacy totals retain their original semantics. New budgets use two caps.
export const budgetSchema = z.preprocess((value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const b = value as Record<string, unknown>;
	if (
		b.tokens !== undefined &&
		b.inputTokens === undefined &&
		b.outputTokens === undefined
	)
		return b;
	const inputTokens = b.inputTokens ?? 1000000;
	const outputTokens = b.outputTokens ?? 100000;
	return {
		...b,
		inputTokens,
		outputTokens,
		tokens:
			typeof inputTokens === "number" && typeof outputTokens === "number"
				? inputTokens + outputTokens
				: b.tokens,
	};
}, budgetFields);
export const createJobSchema = z.object({
	engineVersion: z.union([z.literal(1), z.literal(2)]).default(2),
	topic: z.string().trim().min(2).max(400),
	mode: z.enum(["mock", "live"]).default("mock"),
	strategy: z.enum(["balanced", "diverse"]).default("balanced"),
	seed: z
		.enum(["manual", "knowledge", "finding", "vibe", "episode"])
		.default("manual"),
	budget: budgetSchema.default(() => budgetSchema.parse({})),
});
export type JobInput = z.infer<typeof createJobSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Usage = Record<
	"queries" | "urls" | "documents" | "tokens" | "requests" | "costUsd",
	number
> & { inputTokens?: number; outputTokens?: number };
export type Status =
	| "queued"
	| "running"
	| "finalizing"
	| "completed"
	| "partial"
	| "cancel_requested"
	| "cancelled"
	| "failed";
export interface Job {
	id: string;
	topic: string;
	mode: "mock" | "live";
	strategy: string;
	seed: string;
	budget: Budget;
	usage: Usage;
	status: Status;
	reason: string | null;
	createdAt: number;
	startedAt: number | null;
	deadline: number | null;
	updatedAt: number;
	config: Record<string, unknown>;
}
export interface Query {
	id: string;
	query: string;
	depth: number;
	score: number;
	reason: string;
	status: "pending" | "searched" | "skipped";
	known: string;
}
export interface Hit {
	url: string;
	title: string;
	snippet: string;
	rank: number;
}
export interface PdfPage {
	page: number;
	/** UTF-16 offsets in the final Snapshot.text; empty for unread pages. */
	start: number;
	end: number;
	status: "extracted" | "partial" | "unread" | "blank";
	method: "embedded-text";
	layout: "single-column" | "two-column" | "uncertain";
	warnings: string[];
}
export interface PdfMetadata {
	rawHash: string;
	pages: number;
	/** Optional for snapshots created before PDF coverage tracking. */
	pageMap?: PdfPage[];
	omittedPages?: { from: number; to: number; reason: string }[];
	coverage?: "text-extracted" | "partial" | "unread";
	warnings?: string[];
}
export interface Snapshot {
	links?: {
		url: string;
		text: string;
		context: string;
		kind: "continuation" | "reference";
		section: string;
	}[];
	headings?: string[];
	pdf?: PdfMetadata;
	decoding?: { encoding: string; rawHash: string };
	author: string | null;
	publishedAt: string | null;
	id: string;
	url: string;
	finalUrl: string;
	title: string;
	text: string;
	hash: string;
	fetchedAt: string;
	fetchMethod: string;
	truncated: boolean;
	security: unknown;
	extractor: string;
	fixture: boolean;
}
export interface Evidence {
	id: string;
	snapshotId: string;
	quote: string;
	start: number;
	end: number;
	context: string;
}
export interface Claim {
	id: string;
	text: string;
	evidenceIds: string[];
	confidence: number;
	kind: "NEW" | "KNOWN" | "DUPLICATE" | "CONTRADICTION" | "WEAK_EVIDENCE";
	accepted: boolean;
	reason: string;
	relatedClaimIds: string[];
}
export interface Artifact {
	memoryId?: string;
	evidenceUnavailable?: boolean;
	qualityState?: "reviewed" | "needs_revision";
	sections?: ReportSection[];
	limitations?: string[];
	openQuestions?: string[];
	worldModelDiscovery?: import("../research/world-model-schema").WorldModelDiscovery;
	id: string;
	version: number;
	title: string;
	body: string;
	claimIds: string[];
	generatedAt: string;
	fixture: boolean;
}
export interface Candidate {
	memoryId?: string;
	artifactVersion?: number;
	eventIds?: number[];
	id: string;
	type: "knowledge" | "episode";
	text: string;
	claimIds: string[];
	adoption: "pending" | "accepted" | "rejected";
}
export interface Event {
	id: number;
	jobId: string;
	type: string;
	data: unknown;
	createdAt: number;
}
export interface JobDetail {
	importedRun?: {
		importedAt: string;
		execution: string;
		originalEventIdsPreserved: boolean;
	};
	memory?: import("../memory/schema").MemoryBundle[];
	memoryBrief?: import("../research/rounds").Brief;
	research?: ResearchState;
	qualityReviews?: {
		version: number;
		review: {
			verdict: string;
			scores: Record<string, number>;
			majorIssues?: string[];
			improvements?: string[];
		};
	}[];
	job: Job;
	queries: Query[];
	edges: { from: string; to: string; source: string }[];
	sources: Snapshot[];
	evidence: Evidence[];
	claims: Claim[];
	artifacts: Artifact[];
	candidates: Candidate[];
	events: Event[];
	operations: unknown[];
}
export const claimResponse = z.object({
	claims: z
		.array(
			z.object({
				text: z.string().min(1).max(2000),
				quote: z.string().min(8).max(4000),
				confidence: z.number().min(0).max(1),
				relation: z.enum(["supports", "contradicts"]).default("supports"),
				relatedClaimId: z.string().optional(),
			}),
		)
		.max(8),
	concepts: z.array(z.string().min(2).max(200)).max(3).default([]),
});

export const reportResponse = z.object({
	claimIds: z.array(z.string()).min(1),
	sections: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				paragraphs: z
					.array(
						z.object({
							text: z.string().min(1).max(2400),
							kind: z.enum(["finding", "inference"]),
							claimIds: z.array(z.string()).min(1),
						}),
					)
					.min(1)
					.max(8),
			}),
		)
		.min(1)
		.max(10)
		.optional(),
	limitations: z.array(z.string().max(1200)).max(12).optional(),
	openQuestions: z.array(z.string().max(600)).max(8).optional(),
});
export type ReportSection = NonNullable<
	z.infer<typeof reportResponse>["sections"]
>[number];
