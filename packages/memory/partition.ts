import type { JobDetail } from "../contracts";
import { memoryContext, type MemoryBundle, type memorySchemas } from "./index";
/** Explicit dependency batches; omitted IDs remain visible, never represented by a summary as evidence. */
export function memoryPartitions(
	kind: keyof typeof memorySchemas,
	detail: JobDetail,
	bundle: MemoryBundle,
	previous: MemoryBundle | undefined,
	maxBytes: number,
) {
	const full = memoryContext(kind, detail, bundle, previous);
	if (Buffer.byteLength(JSON.stringify(full)) <= maxBytes) return [full];
	const claims = detail.claims.filter((c) => c.accepted);
	const objects = [...bundle.knowledge, ...bundle.episodes, ...bundle.concepts];
	const units: {
		claimIds: string[];
		eventIds: number[];
		targetIds: string[];
	}[] =
		kind === "memory_episode"
			? bundle.events.map((e) => ({
					claimIds: [],
					eventIds: [e.id],
					targetIds: bundle.episodes
						.filter((o) => o.eventIds.includes(e.id))
						.map((o) => o.id),
				}))
			: kind === "memory_review"
				? objects.map((o) => ({
						claimIds: o.claimIds,
						eventIds: "eventIds" in o ? o.eventIds : [],
						targetIds: [o.id],
					}))
				: claims.map((c) => ({
						claimIds: [c.id],
						eventIds: [],
						targetIds: objects
							.filter((o) => o.claimIds.includes(c.id))
							.map((o) => o.id),
					}));
	if (!units.length) throw Error("MEMORY_CONTEXT_MINIMUM_EXCEEDS_LIMIT");
	// A saved object is an indivisible dependency unit: keep all of its sources,
	// even when only one claim/event triggered this partition.
	const batches = [
		...new Map(
			units.map((unit) => {
				const targets = objects.filter((o) => unit.targetIds.includes(o.id));
				const batch = {
					...unit,
					claimIds: [
						...new Set([
							...unit.claimIds,
							...targets.flatMap((o) => o.claimIds),
						]),
					].sort(),
					eventIds: [
						...new Set([
							...unit.eventIds,
							...targets.flatMap((o) => ("eventIds" in o ? o.eventIds : [])),
						]),
					].sort((a, b) => a - b),
				};
				return [JSON.stringify(batch), batch] as const;
			}),
		).values(),
	];
	return batches.map((unit, index) => {
		const related = {
			...bundle,
			knowledge: bundle.knowledge.filter((o) => unit.targetIds.includes(o.id)),
			episodes: bundle.episodes.filter((o) => unit.targetIds.includes(o.id)),
			concepts: bundle.concepts.filter((o) => unit.targetIds.includes(o.id)),
			relations: bundle.relations.filter(
				(o) => unit.targetIds.includes(o.from) && unit.targetIds.includes(o.to),
			),
			evidence: bundle.evidence.filter((e) =>
				unit.claimIds.includes(e.claimId),
			),
			events: bundle.events.filter((e) => unit.eventIds.includes(e.id)),
			review: bundle.review
				? {
						...bundle.review,
						defects: bundle.review.defects.filter((d) =>
							unit.targetIds.includes(d.targetId),
						),
					}
				: null,
		};
		const selected = {
			...detail,
			claims: detail.claims.filter((c) => unit.claimIds.includes(c.id)),
			events: detail.events.filter((e) => unit.eventIds.includes(e.id)),
		};
		const input = {
			...memoryContext(kind, selected, related, undefined),
			partition: {
				index,
				count: batches.length,
				targetIds: unit.targetIds,
				omittedClaimIds: claims
					.filter((c) => !unit.claimIds.includes(c.id))
					.map((c) => c.id),
				omittedEventIds: bundle.events
					.filter((e) => !unit.eventIds.includes(e.id))
					.map((e) => e.id),
				scope:
					"Inspect only this dependency batch; do not assert bundle-wide completeness.",
			},
		};
		if (Buffer.byteLength(JSON.stringify(input)) > maxBytes)
			throw Error("MEMORY_CONTEXT_MINIMUM_EXCEEDS_LIMIT");
		return input;
	});
}
