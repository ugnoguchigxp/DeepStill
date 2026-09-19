import { z } from "zod";

const text = z.string().trim().min(1);

export const discoveryRelationSchema = z.enum([
	"causes",
	"increases",
	"decreases",
	"enables",
	"inhibits",
	"correlates_with",
	"depends_on",
	"has_goal",
	"serves_goal",
]);
export const discoveryAssessmentSchema = z.enum([
	"hypothesis",
	"supported",
	"disputed",
	"insufficient_evidence",
	"refuted",
]);
export const discoveryBasisSchema = z.enum(["source_statement", "inference"]);
export const discoveryGapKindSchema = z.enum([
	"missing_knowledge",
	"unknown_causal_direction",
	"missing_mechanism",
	"missing_condition",
	"conflicting_evidence",
	"unknown_applicability",
]);
export const discoveryEvidenceRoleSchema = z.enum([
	"supports",
	"contradicts",
	"background",
]);
export const discoveryEvidenceMethodSchema = z.enum([
	"experiment",
	"observation",
	"theory",
	"author_statement",
	"unknown",
]);
export const discoveryCorrelationDirectionSchema = z.enum([
	"positive",
	"negative",
	"unknown",
]);

export type DiscoveryRelation = z.infer<typeof discoveryRelationSchema>;
export type DiscoveryAssessment = z.infer<typeof discoveryAssessmentSchema>;
export type DiscoveryBasis = z.infer<typeof discoveryBasisSchema>;
export type DiscoveryGapKind = z.infer<typeof discoveryGapKindSchema>;
export type DiscoveryEvidenceRole = z.infer<typeof discoveryEvidenceRoleSchema>;
export type DiscoveryEvidenceMethod = z.infer<
	typeof discoveryEvidenceMethodSchema
>;
export type DiscoveryCorrelationDirection = z.infer<
	typeof discoveryCorrelationDirectionSchema
>;

export const citationSchema = z.union([
	z.object({
		sourceId: text,
		firstLine: z.number().int().positive(),
		lastLine: z.number().int().positive(),
	}),
	z.object({ sourceId: text, quote: text.max(4000) }),
]);
export const discoveryCitationSchema = citationSchema;
export type Citation = z.infer<typeof citationSchema>;

export const discoveryGapInputSchema = z.object({
	kind: discoveryGapKindSchema,
	question: text.max(400),
	relevance: z.enum(["required", "optional"]),
	reason: text.max(400),
});

export const discoveryCandidateEvidenceInputSchema = z.object({
	role: discoveryEvidenceRoleSchema,
	method: discoveryEvidenceMethodSchema,
	note: text.max(400),
	citations: z.array(citationSchema).min(1).max(4),
});

export const discoveryCandidateInputSchema = z.object({
	subject: text.max(160),
	relation: discoveryRelationSchema,
	object: text.max(160),
	correlationDirection: discoveryCorrelationDirectionSchema.nullable(),
	assessment: discoveryAssessmentSchema,
	basis: discoveryBasisSchema,
	explanation: text.max(800),
	conditions: z.array(text.max(300)).max(6),
	exceptions: z.array(text.max(300)).max(6),
	scope: text.max(400).nullable(),
	alternatives: z.array(text.max(300)).max(6),
	evidence: z.array(discoveryCandidateEvidenceInputSchema).min(1).max(6),
	gaps: z.array(discoveryGapInputSchema).max(3),
});

export const discoveryInputSchema = z.object({
	changeReason: text.max(800),
	candidates: z.array(discoveryCandidateInputSchema).max(8),
	gaps: z.array(discoveryGapInputSchema).max(8),
});

export const discoveryEvidenceSchema = z.object({
	role: discoveryEvidenceRoleSchema,
	method: discoveryEvidenceMethodSchema,
	note: text.max(400),
	evidenceIds: z.array(text).min(1).max(4),
});

export const discoveryCandidateSchema = discoveryCandidateInputSchema
	.omit({ evidence: true })
	.extend({
		id: z.string().regex(/^wmc:[0-9a-f]{24}$/),
		evidence: z.array(discoveryEvidenceSchema).min(1).max(6),
	});

export const worldModelDiscoverySchema = z.object({
	schemaVersion: z.literal(1),
	basedOnArtifactVersion: z.number().int().positive(),
	changeReason: text.max(800),
	candidates: z.array(discoveryCandidateSchema).max(8),
	gaps: z.array(discoveryGapInputSchema).max(8),
});

export type DiscoveryGapInput = z.infer<typeof discoveryGapInputSchema>;
export type DiscoveryCandidateInput = z.infer<
	typeof discoveryCandidateInputSchema
>;
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export type DiscoveryEvidence = z.infer<typeof discoveryEvidenceSchema>;
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export type WorldModelDiscovery = z.infer<typeof worldModelDiscoverySchema>;

export const CAUSAL_DISCOVERY_RELATIONS = [
	"causes",
	"increases",
	"decreases",
	"enables",
	"inhibits",
] as const satisfies readonly DiscoveryRelation[];

export function assertDiscoveryCandidateSemantics(candidate: {
	relation: DiscoveryRelation;
	correlationDirection: DiscoveryCorrelationDirection | null;
	assessment: DiscoveryAssessment;
	basis: DiscoveryBasis;
	evidence: { role: DiscoveryEvidenceRole }[];
}) {
	if (candidate.relation === "correlates_with") {
		if (candidate.correlationDirection == null)
			throw Error("INVALID_DISCOVERY_CORRELATION_DIRECTION");
	} else if (candidate.correlationDirection != null)
		throw Error("INVALID_DISCOVERY_CORRELATION_DIRECTION");
	const roles = new Set(candidate.evidence.map((item) => item.role));
	if (candidate.assessment === "supported" && !roles.has("supports"))
		throw Error("INVALID_DISCOVERY_EVIDENCE_ROLE");
	if (candidate.assessment === "refuted" && !roles.has("contradicts"))
		throw Error("INVALID_DISCOVERY_EVIDENCE_ROLE");
	if (
		candidate.assessment === "disputed" &&
		(!roles.has("supports") || !roles.has("contradicts"))
	)
		throw Error("INVALID_DISCOVERY_EVIDENCE_ROLE");
	if (
		candidate.basis === "inference" &&
		(CAUSAL_DISCOVERY_RELATIONS as readonly string[]).includes(
			candidate.relation,
		) &&
		candidate.assessment === "supported"
	)
		throw Error("INVALID_DISCOVERY_INFERENCE_ASSESSMENT");
}

export function assertDiscoverySemantics(input: DiscoveryInput) {
	for (const candidate of input.candidates)
		assertDiscoveryCandidateSemantics(candidate);
}

export function assertStoredDiscoverySemantics(discovery: WorldModelDiscovery) {
	const seen = new Set<string>();
	for (const candidate of discovery.candidates) {
		if (seen.has(candidate.id)) throw Error("DUPLICATE_DISCOVERY_CANDIDATE");
		seen.add(candidate.id);
		assertDiscoveryCandidateSemantics(candidate);
	}
}

export function parseDiscoveryInput(value: unknown): DiscoveryInput {
	const parsed = discoveryInputSchema.parse(value);
	assertDiscoverySemantics(parsed);
	return parsed;
}
