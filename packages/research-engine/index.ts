import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Job, JobDetail, Status } from "../contracts";
import type { Budget } from "../contracts";
import { projectWebEvidence } from "../research/resource";
import type { RepositoryIdentity } from "../repository-identity";
import type { EvidenceLocator } from "../source-connector";

export interface EngineCapabilities {
	pluginId: string;
	pluginVersion: string;
	engine: { id: string; version: string };
	operations: AdapterOperation[];
	sourceKinds: string[];
	outputKinds: string[];
	locatorKinds: string[];
	optionalHostCapabilities: string[];
}

export type AdapterOperation =
	| "submit"
	| "status"
	| "result"
	| "cancel"
	| "acknowledge";

export interface AdapterSubmitRequest {
	idempotencyKey: string;
	requestHash: string;
	question: string;
	strategy?: "balanced" | "diverse";
	targetBudget?: Partial<Budget>;
	hardSafetyCeiling: Partial<Budget>;
	expectedOutputs: string[];
	parentRef?: { kind: string; id: string };
	repositoryIdentity?: RepositoryIdentity;
}

export interface AdapterJobRef {
	jobId: string;
	created: boolean;
}

export interface AdapterJobStatus {
	jobId: string;
	status: Status;
	reason: string | null;
	resultAvailable: boolean;
}

export interface AckResult {
	acknowledged: boolean;
	resultHash: string;
}

export interface ResearchEngineAdapter {
	capabilities(): Promise<EngineCapabilities>;
	submit(request: AdapterSubmitRequest): Promise<AdapterJobRef>;
	status(jobId: string): Promise<AdapterJobStatus>;
	result(jobId: string): Promise<ResearchResultProjection>;
	cancel(jobId: string): Promise<AdapterJobStatus>;
	acknowledge(jobId: string, resultHash: string): Promise<AckResult>;
}

export interface InternalResearchPort {
	create(input: {
		job: Pick<Job, "topic" | "mode" | "strategy" | "seed" | "budget">;
		metadata: Record<string, unknown>;
	}): Promise<{ jobId: string }>;
	read(jobId: string): Promise<JobDetail | null>;
	cancel(jobId: string): Promise<Job | null>;
}

export interface ProjectedEvidence {
	id: string;
	claimIds: string[];
	quote: string;
	context: string;
	locator: EvidenceLocator;
}

export interface ProjectedReport {
	id: string;
	version: number;
	title: string;
	body: string;
	claimIds: string[];
	generatedAt: string;
	sections?: {
		title: string;
		paragraphs: {
			text: string;
			kind: "finding" | "inference";
			claimIds: string[];
		}[];
	}[];
	limitations?: string[];
	openQuestions?: string[];
	qualityState?: "reviewed" | "needs_revision";
	evidenceUnavailable?: boolean;
}

export interface ProjectedClaim {
	id: string;
	text: string;
	evidenceIds: string[];
	confidence: number;
	kind: JobDetail["claims"][number]["kind"];
	relatedClaimIds: string[];
}

export interface ProjectedCandidate {
	id: string;
	type: "knowledge";
	text: string;
	claimIds: string[];
	adoption: "pending" | "accepted" | "rejected";
	memoryId?: string;
	artifactVersion?: number;
	eventIds?: number[];
}

export interface ResearchResultProjection {
	projectionVersion: "deepstill-result-projection-v1";
	resultHash: string;
	execution: {
		jobId: string;
		status: Status;
		reason: string | null;
		resultAvailable: boolean;
		engineVersion: number;
		recipeVersion: string;
		usage: Job["usage"];
	};
	report: ProjectedReport | null;
	claims: ProjectedClaim[];
	evidence: ProjectedEvidence[];
	knowledgeCandidates: ProjectedCandidate[];
	episodeSource: {
		memoryId: string;
		episodes: NonNullable<JobDetail["memory"]>[number]["episodes"];
		events: NonNullable<JobDetail["memory"]>[number]["events"];
	} | null;
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, stable(child)]),
	);
}

function projectionHash(value: unknown) {
	return createHash("sha256")
		.update(JSON.stringify(stable(value)))
		.digest("hex");
}

export function buildDeepStillCapabilities(
	operations: AdapterOperation[] = [],
): EngineCapabilities {
	return {
		pluginId: "deepstill",
		pluginVersion: "0.1.0",
		engine: { id: "deepstill-round", version: "2" },
		operations: [...operations],
		sourceKinds: ["web"],
		outputKinds: [
			"report",
			"claims",
			"evidence",
			"knowledge_candidates",
			"episode_source",
		],
		locatorKinds: ["web-url+snapshot-sha256+utf8-bytes"],
		optionalHostCapabilities: ["knowledge_read"],
	};
}

export function projectResearchResult(
	detail: JobDetail,
): ResearchResultProjection {
	const artifact = detail.artifacts[0] ?? null;
	const report = artifact
		? {
				id: artifact.id,
				version: artifact.version,
				title: artifact.title,
				body: artifact.body,
				claimIds: [...artifact.claimIds],
				generatedAt: artifact.generatedAt,
				sections: artifact.sections?.map((section) => ({
					title: section.title,
					paragraphs: section.paragraphs.map((paragraph) => ({
						text: paragraph.text,
						kind: paragraph.kind,
						claimIds: [...paragraph.claimIds],
					})),
				})),
				limitations: artifact.limitations
					? [...artifact.limitations]
					: undefined,
				openQuestions: artifact.openQuestions
					? [...artifact.openQuestions]
					: undefined,
				qualityState: artifact.qualityState,
				evidenceUnavailable: artifact.evidenceUnavailable,
			}
		: null;
	const acceptedClaims = detail.claims.filter((claim) => claim.accepted);
	const acceptedClaimIds = new Set(acceptedClaims.map((claim) => claim.id));
	const claims = acceptedClaims.map((claim) => ({
		id: claim.id,
		text: claim.text,
		evidenceIds: [...claim.evidenceIds],
		confidence: claim.confidence,
		kind: claim.kind,
		relatedClaimIds: claim.relatedClaimIds.filter((id) =>
			acceptedClaimIds.has(id),
		),
	}));
	const claimIds = new Set(claims.map((claim) => claim.id));
	const reportClaimIds = [
		...(report?.claimIds ?? []),
		...(report?.sections?.flatMap((section) =>
			section.paragraphs.flatMap((paragraph) => paragraph.claimIds),
		) ?? []),
	];
	if (reportClaimIds.some((id) => !claimIds.has(id)))
		throw new Error("INVALID_CLAIM_REFERENCE");
	if (
		detail.candidates.some((candidate) =>
			candidate.claimIds.some((id) => !claimIds.has(id)),
		)
	)
		throw new Error("INVALID_CANDIDATE_CLAIM_REFERENCE");

	const evidenceClaims = new Map<string, string[]>();
	for (const claim of claims)
		for (const evidenceId of claim.evidenceIds) {
			const ids = evidenceClaims.get(evidenceId) ?? [];
			ids.push(claim.id);
			evidenceClaims.set(evidenceId, ids);
		}
	const evidence = [...evidenceClaims].map(([evidenceId, referencedBy]) => {
		const item = detail.evidence.find(
			(candidate) => candidate.id === evidenceId,
		);
		if (!item) throw new Error("INVALID_EVIDENCE_REFERENCE");
		const source = detail.sources.find(
			(candidate) => candidate.id === item.snapshotId,
		);
		if (!source) throw new Error("INVALID_EVIDENCE_REFERENCE");
		return {
			id: item.id,
			claimIds: referencedBy,
			quote: item.quote,
			context: item.context,
			locator: projectWebEvidence(source, item),
		};
	});
	const memory = detail.memory?.find((item) => item.id === artifact?.memoryId);
	if (
		memory?.episodes.some((episode) =>
			episode.claimIds.some((id) => !claimIds.has(id)),
		)
	)
		throw new Error("INVALID_EPISODE_CLAIM_REFERENCE");
	const referencedEventIds = new Set(
		memory?.episodes.flatMap((episode) => episode.eventIds) ?? [],
	);
	const episodeEvents =
		memory?.events.filter((event) => referencedEventIds.has(event.id)) ?? [];
	if (
		memory &&
		[...referencedEventIds].some((id) => {
			const event = episodeEvents.find((candidate) => candidate.id === id);
			const original = detail.events.find((candidate) => candidate.id === id);
			return !event || !original || !isDeepStrictEqual(event, original);
		})
	)
		throw new Error("INVALID_EPISODE_EVENT_REFERENCE");
	const resultAvailable = Boolean(report) && evidence.length > 0;
	const body = {
		projectionVersion: "deepstill-result-projection-v1" as const,
		execution: {
			jobId: detail.job.id,
			status: detail.job.status,
			reason: detail.job.reason,
			resultAvailable,
			engineVersion: Number(detail.job.config.engineVersion ?? 1),
			recipeVersion: [
				detail.job.config.researchFlow ?? "legacy",
				`prompt-${detail.job.config.promptVersion ?? "unknown"}`,
				`memory-${detail.job.config.memoryVersion ?? 0}`,
			].join("/"),
			usage: detail.job.usage,
		},
		report,
		claims,
		evidence,
		knowledgeCandidates: detail.candidates
			.filter((candidate) => candidate.type === "knowledge")
			.map((candidate) => ({
				id: candidate.id,
				type: "knowledge" as const,
				text: candidate.text,
				claimIds: candidate.claimIds,
				adoption: candidate.adoption,
				memoryId: candidate.memoryId,
				artifactVersion: candidate.artifactVersion,
			})),
		episodeSource: memory
			? {
					memoryId: memory.id,
					episodes: memory.episodes,
					events: episodeEvents,
				}
			: null,
	};
	return { ...body, resultHash: projectionHash(body) };
}
