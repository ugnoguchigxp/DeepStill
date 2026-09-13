import type { Artifact, Candidate, JobDetail } from "../contracts";
import { researchBrief } from "../research/scope";

export function researchInput(detail: JobDetail) {
	return {
		topic: detail.job.topic,
		researchBrief: researchBrief(detail.job),
		retrieval: {
			terminationReason: detail.job.reason,
			sources: detail.sources.length,
			failures: detail.events
				.filter((e) => e.type === "source.skipped")
				.map((e) => e.data)
				.slice(-15),
		},
		researchHistory: detail.events
			.filter((e) =>
				[
					"query.selected",
					"query.scope_checked",
					"query.focus_added",
					"source.skipped",
					"artifact.revised",
				].includes(e.type),
			)
			.slice(-30)
			.map((e) => {
				if (e.type !== "query.scope_checked") return e;
				const data = e.data as {
					stage: string;
					decisions: {
						id: string;
						status: string;
						reason: string;
						question: string;
					}[];
				};
				return {
					...e,
					data: {
						stage: data.stage,
						decisions: data.decisions.map((d) => ({
							id: d.id,
							status: d.status,
							reason: d.reason.slice(0, 200),
							question: d.question,
						})),
					},
				};
			}),
		claims: detail.claims
			.filter((c) => c.accepted)
			.map((c) => ({
				id: c.id,
				text: c.text,
				kind: c.kind,
				relatedClaimIds: c.relatedClaimIds,
				sources: c.evidenceIds.map((id) => {
					const e = detail.evidence.find((e) => e.id === id);
					const s = detail.sources.find((s) => s.id === e?.snapshotId);
					return {
						title: s?.title,
						url: s?.finalUrl,
						publishedAt: s?.publishedAt,
						fetchedAt: s?.fetchedAt,
						truncated: s?.truncated,
						quote: e?.quote,
						context:
							e && s
								? s.text.slice(Math.max(0, e.start - 450), e.end + 450)
								: undefined,
					};
				}),
			})),
	};
}

/** A candidate carries its report context and provenance, never an invented experience. */
export function reportCandidates(
	detail: JobDetail,
	artifact: Artifact,
): Candidate[] {
	const paragraphs =
		artifact.sections?.flatMap((s) =>
			s.paragraphs.map((p) => ({ ...p, title: s.title })),
		) || [];
	const knowledge: Candidate[] = paragraphs.length
		? paragraphs.map((p, i) => ({
				id: `${artifact.id}:knowledge:${i}`,
				type: "knowledge",
				artifactVersion: artifact.version,
				text: `${artifact.title} — ${p.title}\n${p.kind === "inference" ? "資料からの推論。" : ""}${p.text}`,
				claimIds: p.claimIds,
				adoption: "pending",
			}))
		: artifact.claimIds.map((id) => ({
				id: `${artifact.id}:knowledge:${id}`,
				type: "knowledge",
				artifactVersion: artifact.version,
				text: `${artifact.title}\n${detail.claims.find((c) => c.id === id)?.text || ""}`,
				claimIds: [id],
				adoption: "pending",
			}));
	const queries = detail.queries.filter((q) => q.status === "searched");
	const events = detail.events.filter((e) =>
		[
			"query.scope_checked",
			"source.skipped",
			"query.focus_added",
			"artifact.revised",
		].includes(e.type),
	);
	const episode: Candidate = {
		id: `${artifact.id}:episode`,
		type: "episode",
		artifactVersion: artifact.version,
		text: [
			`「${detail.job.topic}」を調査。レポート第${artifact.version}版。`,
			queries.length
				? `実行した検索：${queries.map((q) => q.query).join("、")}。`
				: "検索経緯はこの記録にありません。",
			paragraphs.length
				? `今回の整理：${paragraphs[0].text}`
				: "本文に統合された結論はありません。",
			artifact.limitations?.length
				? `確認の限界：${artifact.limitations.join(" ")}`
				: "",
			artifact.openQuestions?.length
				? `残った問い：${artifact.openQuestions.join(" ")}`
				: "",
			`終了理由：${detail.job.reason ?? "frontier_empty"}。理解の変化や実践での成果は、この記録のみからは断定しません。`,
		]
			.filter(Boolean)
			.join("\n\n"),
		claimIds: artifact.claimIds,
		eventIds: events.map((e) => e.id),
		adoption: "pending",
	};
	return [...knowledge, episode];
}

export function currentCandidates(
	candidates: Candidate[],
	artifacts: Artifact[],
) {
	const latest = Math.max(0, ...artifacts.map((a) => a.version));
	return candidates.filter(
		(c) =>
			(c.memoryId
				? artifacts.some(
						(a) => a.version === latest && a.memoryId === c.memoryId,
					)
				: c.artifactVersion === latest) ||
			(latest <= 1 && c.artifactVersion === undefined),
	);
}

export function revisionFeedback(
	detail: JobDetail,
	legacy?: { review?: { majorIssues?: string[]; improvements?: string[] } },
) {
	const version = detail.artifacts[0]?.version;
	const review =
		detail.qualityReviews?.find((r) => r.version === version)?.review ??
		legacy?.review;
	return review
		? {
				majorIssues: review.majorIssues ?? [],
				improvements: review.improvements ?? [],
			}
		: undefined;
}
