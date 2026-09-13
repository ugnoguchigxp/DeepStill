import type { JobDetail } from "../contracts";
import type { MemoryBundle } from "./schema";
import { digest } from "../research/direction";
/** Expand changed evidence through existing object dependencies; keep unrelated objects intact. */
export function changedMemoryClaims(
	detail: JobDetail,
	current: MemoryBundle,
	previous?: MemoryBundle,
) {
	if (!previous) return null;
	const ids = new Set(detail.claims.filter((c) => c.accepted).map((c) => c.id));
	const changed = new Set<string>();
	for (const id of new Set([
		...ids,
		...previous.evidence.map((e) => e.claimId),
	])) {
		if (
			digest(current.evidence.filter((e) => e.claimId === id)) !==
			digest(previous.evidence.filter((e) => e.claimId === id))
		)
			changed.add(id);
	}
	if (!changed.size) return null; // A changed brief/prompt still requires the full relevant writer.
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const o of [...previous.knowledge, ...previous.concepts])
			if (o.claimIds.some((id) => changed.has(id)))
				for (const id of o.claimIds)
					if (!changed.has(id)) {
						changed.add(id);
						expanded = true;
					}
	}
	return [...changed];
}
export function selectMemoryDependencies(
	bundle: MemoryBundle,
	claimIds: string[],
) {
	const selected = new Set(claimIds);
	const knowledge = bundle.knowledge.filter((o) =>
		o.claimIds.some((id) => selected.has(id)),
	);
	const concepts = bundle.concepts.filter((o) =>
		o.claimIds.some((id) => selected.has(id)),
	);
	const episodes = bundle.episodes.filter((o) =>
		o.claimIds.some((id) => selected.has(id)),
	);
	const ids = new Set(
		[...knowledge, ...concepts, ...episodes].map((o) => o.id),
	);
	return {
		...bundle,
		knowledge,
		concepts,
		episodes,
		relations: bundle.relations.filter((r) => ids.has(r.from) && ids.has(r.to)),
		evidence: bundle.evidence.filter((e) => selected.has(e.claimId)),
	};
}
