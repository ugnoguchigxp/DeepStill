import { createHash } from "node:crypto";
import type { MemoryReview } from "./schema";
export interface MemoryGap {
	id: string;
	targetId: string;
	requirementId: string;
	completionCriterion: string;
	reason: string;
	claimIds: string[];
	critical: boolean;
	route: MemoryReview["defects"][number]["route"];
	operation: "revise_memory" | "read_source" | "search" | "wait_approval";
	memoryId: string;
	state: "open" | "resolved";
	history: { memoryId: string; state: "open" | "resolved"; reason: string }[];
}
export function updateGaps(
	previous: MemoryGap[],
	review: MemoryReview,
	memoryId: string,
) {
	const gaps = new Map(
		previous.map((g) => [g.id, { ...g, history: [...g.history] }]),
	);
	for (const d of review.defects) {
		const id = `gap:${createHash("sha256")
			.update(
				JSON.stringify([d.targetId, d.requirementId, d.completionCriterion]),
			)
			.digest("hex")
			.slice(0, 24)}`;
		const old = gaps.get(id);
		gaps.set(id, {
			...d,
			operation:
				d.route === "revise_memory"
					? "revise_memory"
					: d.route === "inspect_evidence"
						? "read_source"
						: d.route === "approval_pending"
							? "wait_approval"
							: "search",
			id,
			memoryId,
			state: "open",
			history: [
				...(old?.history ?? []),
				{ memoryId, state: "open", reason: d.reason },
			],
		});
	}
	for (const check of review.rechecks ?? []) {
		const gap = gaps.get(check.id);
		if (!gap) throw Error("UNKNOWN_GAP_RECHECK");
		if (
			check.resolved &&
			review.defects.some(
				(d) =>
					d.targetId === gap.targetId &&
					d.completionCriterion === gap.completionCriterion,
			)
		)
			throw Error("CONTRADICTORY_GAP_RECHECK");
		gap.state = check.resolved ? "resolved" : "open";
		gap.memoryId = memoryId;
		gap.history.push({ memoryId, state: gap.state, reason: check.reason });
	}
	return [...gaps.values()];
}

export function combineReviews(
	previous: MemoryReview | null,
	next: MemoryReview,
): MemoryReview {
	if (!previous) return next;
	const rechecks = new Map((previous.rechecks ?? []).map((c) => [c.id, c]));
	for (const c of next.rechecks ?? []) {
		const prior = rechecks.get(c.id);
		rechecks.set(c.id, prior && !prior.resolved ? prior : c);
	}
	const defects = new Map(
		[...previous.defects, ...next.defects].map((d) => [
			JSON.stringify([d.targetId, d.requirementId, d.completionCriterion]),
			d,
		]),
	);
	return {
		scores: {
			knowledge: Math.min(previous.scores.knowledge, next.scores.knowledge),
			episode: Math.min(previous.scores.episode, next.scores.episode),
			retrieval: Math.min(previous.scores.retrieval, next.scores.retrieval),
		},
		defects: [...defects.values()],
		rechecks: [...rechecks.values()],
	};
}
