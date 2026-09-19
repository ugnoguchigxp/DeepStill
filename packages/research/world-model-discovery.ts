import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "../contracts";
import { resolveCitations } from "./source-citations";
import {
	type DiscoveryCandidate,
	type DiscoveryCandidateInput,
	type DiscoveryGapInput,
	type DiscoveryInput,
	parseDiscoveryInput,
	worldModelDiscoverySchema,
	type WorldModelDiscovery,
} from "./world-model-schema";
export { selectDiscoveryArtifact } from "./world-model-view";

export function discoveryCandidateId(candidate: DiscoveryCandidateInput) {
	const normalize = (value: string) => value.normalize("NFC").trim();
	let subject = normalize(candidate.subject);
	let object = normalize(candidate.object);
	if (candidate.relation === "correlates_with")
		[subject, object] = [subject, object].sort();
	const conditions = [...new Set(candidate.conditions.map(normalize))].sort();
	const scope = candidate.scope == null ? null : normalize(candidate.scope);
	return `wmc:${createHash("sha256")
		.update(
			JSON.stringify([
				subject,
				candidate.relation,
				object,
				scope,
				conditions,
				candidate.correlationDirection,
			]),
		)
		.digest("hex")
		.slice(0, 24)}`;
}

export function mergeDiscovery(
	previous: DiscoveryInput | undefined,
	incoming: DiscoveryInput | null | undefined,
): DiscoveryInput | undefined {
	if (incoming == null) return previous;
	const parsed = parseDiscoveryInput(incoming);
	assertUniqueCandidateIds(parsed.candidates);
	return parsed;
}

export function materializeDiscovery(
	input: DiscoveryInput | undefined,
	sources: Snapshot[],
	artifactVersion: number,
): { discovery: WorldModelDiscovery | undefined; evidence: Evidence[] } {
	if (!input) return { discovery: undefined, evidence: [] };
	const parsed = parseDiscoveryInput(input);
	assertUniqueCandidateIds(parsed.candidates);
	const evidence: Evidence[] = [];
	const candidates: DiscoveryCandidate[] = parsed.candidates.map(
		(candidate) => {
			const id = discoveryCandidateId(candidate);
			return {
				...candidate,
				id,
				evidence: candidate.evidence.map((item) => {
					const resolved = resolveCitations(item.citations, sources);
					for (const entry of resolved)
						if (!evidence.some((existing) => existing.id === entry.id))
							evidence.push(entry);
					return {
						role: item.role,
						method: item.method,
						note: item.note,
						evidenceIds: resolved.map((entry) => entry.id),
					};
				}),
			};
		},
	);
	return {
		discovery: worldModelDiscoverySchema.parse({
			schemaVersion: 1,
			basedOnArtifactVersion: artifactVersion,
			changeReason: parsed.changeReason,
			candidates,
			gaps: parsed.gaps,
		}),
		evidence,
	};
}

export function discoveryNavigationContext(input: DiscoveryInput | undefined):
	| {
			candidates: {
				subject: string;
				relation: DiscoveryCandidateInput["relation"];
				object: string;
				assessment: DiscoveryCandidateInput["assessment"];
				conditions: string[];
			}[];
			gaps: DiscoveryGapInput[];
	  }
	| undefined {
	if (!input) return undefined;
	const gaps: DiscoveryGapInput[] = [];
	const seen = new Set<string>();
	for (const gap of [
		...input.gaps,
		...input.candidates.flatMap((candidate) => candidate.gaps),
	]) {
		const key = `${gap.kind}:${gap.question}`;
		if (seen.has(key)) continue;
		seen.add(key);
		gaps.push(gap);
	}
	gaps.sort(
		(left, right) =>
			Number(right.relevance === "required") -
			Number(left.relevance === "required"),
	);
	return {
		candidates: input.candidates.slice(0, 8).map((candidate) => ({
			subject: candidate.subject,
			relation: candidate.relation,
			object: candidate.object,
			assessment: candidate.assessment,
			conditions: candidate.conditions,
		})),
		gaps: gaps.slice(0, 8),
	};
}

function assertUniqueCandidateIds(candidates: DiscoveryCandidateInput[]) {
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const id = discoveryCandidateId(candidate);
		if (seen.has(id)) throw Error("DUPLICATE_DISCOVERY_CANDIDATE");
		seen.add(id);
	}
}

export function requiredDiscoveryGaps(input: DiscoveryInput | undefined) {
	if (!input) return [];
	return [
		...input.gaps,
		...input.candidates.flatMap((candidate) => candidate.gaps),
	].filter((gap) => gap.relevance === "required");
}
