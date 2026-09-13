import { evidenceContract } from "../prompts/contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Artifact, Candidate, JobDetail } from "../contracts";
import { memorySchemas, type MemoryBundle } from "./schema";
import { memoryInstructions } from "./prompts";
import { z } from "zod";
const recipeHash = createHash("sha256")
	.update(
		JSON.stringify({
			contextVersion: 2,
			evidenceContract,
			instructions: memoryInstructions,
			schemas: Object.fromEntries(
				Object.entries(memorySchemas).map(([k, v]) => [k, z.toJSONSchema(v)]),
			),
		}),
	)
	.digest("hex");
export * from "./schema";
const eventTypes = new Set([
	"research.action",
	"deliverable.updated",
	"job.started",
	"query.selected",
	"search.completed",
	"round.started",
	"round.evaluated",
	"round.opportunities_reviewed",
	"source.skipped",
	"source.saved",
	"round.sources_selected",
	"research.decision",
	"research.questions_updated",
	"research.stopped",
	"source.retry",
	"query.scope_checked",
	"artifact.revised",
	"budget.adjusted",
]);
export function memoryInput(detail: JobDetail) {
	const claims = detail.claims.filter((c) => c.accepted);
	const evidence = claims.flatMap((c) =>
		c.evidenceIds.map((id) => {
			const e = detail.evidence.find((e) => e.id === id);
			const s = detail.sources.find((s) => s.id === e?.snapshotId);
			if (
				!e ||
				!s ||
				createHash("sha256").update(s.text).digest("hex") !== s.hash ||
				s.text.slice(e.start, e.end) !== e.quote
			)
				throw new Error("MEMORY_EVIDENCE_INVALID");
			return {
				claimId: c.id,
				text: c.text,
				kind: c.kind,
				evidenceId: e.id,
				snapshotId: s.id,
				hash: s.hash,
				url: s.finalUrl,
				start: e.start,
				end: e.end,
				unit: "utf16" as const,
				quote: e.quote,
			};
		}),
	);
	const events = detail.events.filter((e) => eventTypes.has(e.type));
	const input = {
		brief: detail.memoryBrief ?? null,
		generator: {
			recipeHash,
			mode: detail.job.mode,
			provider: detail.job.config.llmProvider,
			model: detail.job.config.llmModel,
		},
		topic: detail.job.topic,
		terminationReason: detail.job.reason,
		revision: detail.research?.revision ?? 0,
		claims: claims.map((c) => ({
			id: c.id,
			text: c.text,
			kind: c.kind,
			relatedClaimIds: c.relatedClaimIds,
		})),
		evidence,
		events,
	};
	return {
		...input,
		inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
	};
}
export function emptyBundle(
	detail: JobDetail,
	previous?: MemoryBundle,
): MemoryBundle {
	const input = memoryInput(detail);
	return {
		id: `memory:${input.inputHash}`,
		schemaVersion: "memory-v1",
		inputHash: input.inputHash,
		revision: input.revision,
		jobId: detail.job.id,
		topic: detail.job.topic,
		asOf: new Date().toISOString(),
		supersedes: previous?.id ?? null,
		events: input.events,
		knowledge: [],
		episodes: [],
		concepts: [],
		relations: [],
		evidence: input.evidence,
		review: null,
		status: "draft",
		structuralIssues: [],
	};
}
export function validateMemory(
	bundle: MemoryBundle,
	detail: JobDetail,
): string[] {
	const issues: string[] = [];
	const claims = new Set(
		detail.claims.filter((c) => c.accepted).map((c) => c.id),
	);
	const originalEvents = memoryInput(detail).events;
	const events = new Set(originalEvents.map((e) => e.id));
	for (const event of bundle.events)
		if (
			!isDeepStrictEqual(
				event,
				originalEvents.find((e) => e.id === event.id),
			)
		)
			issues.push(`invalid_event_record:${event.id}`);
	const objects = [...bundle.knowledge, ...bundle.episodes, ...bundle.concepts];
	const ids = new Set(objects.map((o) => o.id));
	if (ids.size !== objects.length) issues.push("duplicate_memory_id");
	for (const o of objects)
		for (const id of o.claimIds)
			if (!claims.has(id)) issues.push(`${o.id}:unknown_claim:${id}`);
	for (const k of bundle.knowledge) {
		if (!k.id.startsWith("k:")) issues.push(`${k.id}:id_prefix`);
		if (!k.appliesWhen.length) issues.push(`${k.id}:missing_conditions`);
		if (
			detail.job.config.researchControlVersion === 2 &&
			!k.verification.length
		)
			issues.push(`${k.id}:missing_verification`);
		if (
			k.type === "procedure" &&
			(k.steps.length < 2 ||
				!k.verification.length ||
				k.polarity === "negative")
		)
			issues.push(`${k.id}:incomplete_procedure`);
	}
	for (const e of bundle.episodes) {
		if (!e.id.startsWith("ep:")) issues.push(`${e.id}:id_prefix`);
		for (const id of e.eventIds)
			if (!events.has(id)) issues.push(`${e.id}:unknown_event:${id}`);
	}
	for (const c of bundle.concepts)
		if (!c.id.startsWith("c:")) issues.push(`${c.id}:id_prefix`);
	for (const r of bundle.relations) {
		if (!ids.has(r.from) || !ids.has(r.to)) issues.push("dangling_relation");
		for (const id of r.claimIds)
			if (!claims.has(id)) issues.push(`relation:unknown_claim:${id}`);
	}
	const requirements = new Set([
		"general",
		...(detail.memoryBrief?.requirements.map((r) => r.id) ?? []),
	]);
	for (const d of bundle.review?.defects ?? []) {
		if (d.targetId !== "bundle" && !ids.has(d.targetId))
			issues.push("unknown_defect_target");
		if (!requirements.has(d.requirementId)) issues.push("unknown_requirement");
		for (const id of d.claimIds)
			if (!claims.has(id)) issues.push("unknown_defect_claim");
	}
	const gapIds = new Set(
		(detail.research?.gaps ?? []).flatMap((g) =>
			g && typeof g === "object" && "id" in g && typeof g.id === "string"
				? [g.id]
				: [],
		),
	);
	for (const check of bundle.review?.rechecks ?? [])
		if (!gapIds.has(check.id)) issues.push("unknown_gap_recheck");
	for (const e of bundle.evidence) {
		const s = detail.sources.find((s) => s.id === e.snapshotId);
		const original = detail.evidence.find((x) => x.id === e.evidenceId);
		if (
			!s ||
			s.hash !== e.hash ||
			s.text.slice(e.start, e.end) !== e.quote ||
			!original ||
			original.snapshotId !== e.snapshotId ||
			original.start !== e.start ||
			original.end !== e.end ||
			!detail.claims
				.find((c) => c.id === e.claimId)
				?.evidenceIds.includes(e.evidenceId)
		)
			issues.push("invalid_locator");
	}
	return [...new Set(issues)];
}
/** An LLM review estimate is not a holdout reuse-test result. */
export function memoryReviewPass(bundle: MemoryBundle) {
	return (
		bundle.status === "reviewed" &&
		bundle.structuralIssues.length === 0 &&
		!!bundle.review &&
		Object.values(bundle.review.scores).every((n) => n > 90) &&
		!bundle.review.defects.some((d) => d.critical || d.route !== "supplement")
	);
}
export function memoryCandidates(
	bundle: MemoryBundle,
	artifact: Artifact,
): Candidate[] {
	return [
		...bundle.knowledge.map((k) => ({
			id: `${bundle.id}:${k.id}`,
			type: "knowledge" as const,
			text: JSON.stringify(k, null, 2),
			claimIds: k.claimIds,
		})),
		...bundle.episodes.map((e) => ({
			id: `${bundle.id}:${e.id}`,
			type: "episode" as const,
			text: JSON.stringify(e, null, 2),
			claimIds: e.claimIds,
			eventIds: e.eventIds,
		})),
	].map((c) => ({
		...c,
		memoryId: bundle.id,
		artifactVersion: artifact.version,
		adoption: "pending" as const,
	}));
}
export function memoryObjectStatus(bundle: MemoryBundle, id: string) {
	if (
		bundle.evidence.some((e) => e.evidenceId === id) ||
		bundle.events.some((e) => `event:${e.id}` === id)
	)
		return "accepted";
	const defects =
		bundle.review?.defects.filter(
			(d) => d.targetId === id || d.targetId === "bundle",
		) ?? [];
	if (bundle.structuralIssues.length || defects.some((d) => d.critical))
		return "disputed";
	return bundle.status === "reviewed" &&
		!defects.some((d) => d.route !== "supplement")
		? "accepted"
		: "draft";
}

export function searchMemory(
	bundle: MemoryBundle,
	query: string,
	limit = 10,
	state = "all",
) {
	const q = query.normalize("NFKC").toLowerCase().trim();
	const terms = [...new Set(q.split(/[\s、，。:;]+/u).filter(Boolean))];
	const grams = [
		...new Set(
			(q.match(/[一-龯ぁ-んァ-ヶ]+/gu) ?? []).flatMap((s) =>
				Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
					s.slice(i, i + 2),
				),
			),
		),
	];
	return [
		...bundle.knowledge.map((x) => ({
			id: x.id,
			title: x.title,
			text: [
				x.body,
				...x.appliesWhen,
				...x.notApplicableWhen,
				...x.steps,
				...x.verification,
				...x.unknowns,
			].join(" "),
		})),
		...bundle.events.map((e) => ({
			id: `event:${e.id}`,
			title: `${e.type} 実行記録 ${
				e.type === "query.selected" || e.type === "search.completed"
					? "検索語 探索 query search"
					: e.type === "budget.adjusted"
						? "予算 budget"
						: e.type === "source.retry" || e.type === "source.skipped"
							? "取得 承認 失敗 source approval"
							: "判断 decision"
			}`,
			text: JSON.stringify(e.data),
		})),
		...bundle.episodes.map((x) => ({
			id: x.id,
			title: x.title,
			text: [
				x.context,
				x.intent,
				x.observations,
				x.actionTaken,
				x.outcome,
				...x.decisions,
				...x.failedApproach,
				x.lesson,
				...x.triggers,
				...x.openLoops,
			].join(" "),
		})),
		...bundle.evidence.map((x) => ({
			id: x.evidenceId,
			title: x.text ?? x.quote,
			text: [x.quote, x.url, x.kind].join(" "),
		})),
		...bundle.concepts.map((x) => ({
			id: x.id,
			title: x.name,
			text: [x.description, ...x.aliases].join(" "),
		})),
	]
		.map((x) => ({
			...x,
			memoryId: bundle.id,
			revision: bundle.revision,
			asOf: bundle.asOf,
			status: memoryObjectStatus(bundle, x.id),
		}))
		.filter((x) => state === "all" || x.status === state)
		.map((x) => {
			const text = `${x.title} ${x.text}`.normalize("NFKC").toLowerCase();
			return {
				...x,
				match: {
					phrase: text.includes(q),
					terms: terms.filter((t) => text.includes(t)).length,
					grams: grams.filter((g) => text.includes(g)).length,
				},
			};
		})
		.filter((x) => x.match.phrase || x.match.terms > 0 || x.match.grams >= 2)
		.sort(
			(a, b) =>
				Number(b.match.phrase) - Number(a.match.phrase) ||
				b.match.terms - a.match.terms ||
				b.match.grams - a.match.grams ||
				a.id.localeCompare(b.id),
		)
		.filter((x, i, rows) => rows.findIndex((r) => r.id === x.id) === i)

		.slice(0, Math.max(1, Math.min(50, limit)))
		.map((row) => {
			// Search is an index, not a full object read. Keep the matching context
			// bounded even when a saved evaluation event contains a large payload.
			const normalized = row.text.normalize("NFKC").toLowerCase();
			const position =
				[q, ...terms, ...grams]
					.filter(Boolean)
					.map((term) => normalized.indexOf(term))
					.find((index) => index >= 0) ?? 0;
			const start = Math.max(0, position - 100);
			return {
				...row,
				title: row.title.slice(0, 280),
				text: `${start ? "…" : ""}${row.text.slice(start, start + 600)}${row.text.length > start + 600 ? "…" : ""}`,
			};
		});
}
export function memoryObject(bundle: MemoryBundle, id: string) {
	return (
		[
			...bundle.knowledge,
			...bundle.episodes,
			...bundle.concepts,
			...bundle.events.map((e) => ({
				id: `event:${e.id}`,
				title: e.type,
				eventIds: [e.id],
				claimIds: [] as string[],
				record: e,
			})),
			...bundle.evidence.map((e) => ({
				...e,
				id: e.evidenceId,
				claimIds: bundle.evidence
					.filter((x) => x.evidenceId === e.evidenceId)
					.map((x) => x.claimId),
			})),
		].find((x) => x.id === id) ?? null
	);
}
export function drillMemory(
	bundle: MemoryBundle,
	detail: JobDetail,
	evidenceId: string,
) {
	const refs = bundle.evidence.filter((e) => e.evidenceId === evidenceId);
	if (!refs.length) return null;
	const e = refs[0],
		s = detail.sources.find((s) => s.id === e.snapshotId);
	if (
		!s ||
		s.hash !== e.hash ||
		createHash("sha256").update(s.text).digest("hex") !== e.hash ||
		s.text.slice(e.start, e.end) !== e.quote
	)
		throw new Error("MEMORY_LOCATOR_STALE");
	return {
		...e,
		claimIds: refs.map((e) => e.claimId),
		context: s.text.slice(Math.max(0, e.start - 450), e.end + 450),
	};
}
export function contextStillExport(bundle: MemoryBundle, detail?: JobDetail) {
	return {
		schemaVersion: "contextstill-dry-run-v1",
		sourceMemoryId: bundle.id,
		writePerformed: false,
		knowledge: bundle.knowledge
			.filter(
				(k) =>
					k.appliesWhen.length &&
					k.verification.length &&
					(k.type !== "procedure" || k.steps.length >= 2),
			)
			.map((k) => ({
				type: k.type,
				polarity: k.polarity,
				title: k.title,
				status: "draft",
				body:
					k.type === "procedure"
						? `Use when:\n${k.appliesWhen.join("\n")}\nWorkflow:\n${k.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nVerification:\n${k.verification.join("\n")}${k.notApplicableWhen.length ? `\nAvoid:\n${k.notApplicableWhen.join("\n")}` : ""}`
						: k.body,
				metadata: {
					memoryId: bundle.id,
					canonical: k,
					refs: bundle.evidence
						.filter((e) => k.claimIds.includes(e.claimId))
						.map((e) => {
							const source = detail?.sources.find((s) => s.id === e.snapshotId);
							return {
								...e,
								utf8Range: source
									? {
											start: Buffer.byteLength(source.text.slice(0, e.start)),
											end: Buffer.byteLength(source.text.slice(0, e.end)),
										}
									: null,
								targetContractVerified: false,
							};
						}),
				},
			})),
		episodes: bundle.episodes.map((e) => ({
			canonical: e,
			asOf: bundle.asOf,
			requiresAdapterContract: true,
		})),
		unresolvedContracts: [
			"Episode sourceKind and event/raw-file reference mapping requires target contract validation",
		],
	};
}

/** Keep narrative claims out of the episode writer's context; events are its source of truth. */
export function memoryContext(
	kind: keyof typeof import("./schema").memorySchemas,
	detail: JobDetail,
	bundle: MemoryBundle,
	previous?: MemoryBundle,
) {
	const source = memoryInput(detail);
	const base = {
		...source,
		generationVersion: detail.job.config.researchControlVersion === 2 ? 2 : 1,
		asOf: bundle.asOf,
		brief: detail.memoryBrief,
	};
	if (kind === "memory_episode")
		return {
			...base,
			claims: [],
			evidence: [],
			memory: {
				episodes: bundle.episodes,
				feedback:
					bundle.review?.defects.filter(
						(d) => d.targetId === "bundle" || d.targetId.startsWith("ep:"),
					) ?? [],
			},
			previous: previous?.episodes ?? [],
		};
	if (kind === "memory_knowledge")
		return {
			...base,
			events: [],
			memory: {
				knowledge: bundle.knowledge,
				feedback:
					bundle.review?.defects.filter(
						(d) => d.targetId === "bundle" || d.targetId.startsWith("k:"),
					) ?? [],
			},
			previous: previous?.knowledge ?? [],
		};
	if (kind === "memory_concepts")
		return {
			...base,
			events: [],
			memory: {
				knowledge: bundle.knowledge,
				episodes: bundle.episodes,
				concepts: bundle.concepts,
				relations: bundle.relations,
				structuralIssues: bundle.structuralIssues,
				feedback: bundle.review?.defects ?? [],
			},
			previous: previous?.concepts ?? [],
		};
	return {
		...base,
		memory: {
			...bundle,
			review: bundle.review ? { defects: bundle.review.defects } : null,
		},
		previous: null,
	};
}

/** Hash only dependencies that can change this writer's output. */
export function memoryStageHash(
	kind: keyof typeof memorySchemas,
	detail: JobDetail,
	bundle: MemoryBundle,
) {
	const source = memoryInput(detail);
	const common = {
		recipeHash,
		generator: source.generator,
		topic: source.topic,
		brief: source.brief?.requirements.map((r) => ({
			id: r.id,
			text: r.text,
			required: r.required,
			criterion: r.criterion,
		})),
	};
	const input =
		kind === "memory_episode"
			? {
					...common,
					events: source.events,
					terminationReason: source.terminationReason,
				}
			: kind === "memory_knowledge"
				? { ...common, claims: source.claims, evidence: source.evidence }
				: kind === "memory_concepts"
					? {
							...common,
							claims: source.claims,
							evidence: source.evidence,
							knowledge: bundle.knowledge,
						}
					: {
							...common,
							evidence: source.evidence,
							knowledge: bundle.knowledge,
							episodes: bundle.episodes,
							concepts: bundle.concepts,
							relations: bundle.relations,
						};
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Allocate identifiers in code; preserve an existing ID only for an overlapping supported object. */
export function allocateMemoryIds(
	bundle: MemoryBundle,
	previous?: MemoryBundle,
) {
	const aliases = new Map<string, string>();
	const prior = [
		...(previous?.knowledge ?? []),
		...(previous?.episodes ?? []),
		...(previous?.concepts ?? []),
	];
	for (const group of [bundle.knowledge, bundle.episodes, bundle.concepts])
		for (const o of group) {
			const old = prior.find(
				(p) =>
					p.id === o.id &&
					(p.claimIds.some((id) => o.claimIds.includes(id)) ||
						("eventIds" in p &&
							"eventIds" in o &&
							p.eventIds.some((id) => o.eventIds.includes(id)))),
			);
			const prefix = "steps" in o ? "k:" : "eventIds" in o ? "ep:" : "c:";
			const name = "title" in o ? o.title : o.name;
			const id =
				old?.id ??
				`${prefix}${createHash("sha256")
					.update(
						JSON.stringify({
							jobId: bundle.jobId,
							name,
							claims: [...o.claimIds].sort(),
							events: "eventIds" in o ? o.eventIds : [],
						}),
					)
					.digest("hex")
					.slice(0, 24)}`;
			aliases.set(o.id, id);
			o.id = id;
		}
	bundle.relations = bundle.relations.map((r) => ({
		status: "suggested",
		...r,
		from: aliases.get(r.from) ?? r.from,
		to: aliases.get(r.to) ?? r.to,
	}));
	bundle.objectMetadata = Object.fromEntries(
		[...bundle.knowledge, ...bundle.episodes, ...bundle.concepts].map((o) => [
			o.id,
			{
				schemaVersion: "memory-object-v1" as const,
				researchRevision: bundle.revision,
				inputHash:
					bundle.stageHashes?.[
						"steps" in o
							? "memory_knowledge"
							: "eventIds" in o
								? "memory_episode"
								: "memory_concepts"
					] ?? bundle.inputHash,
				contentHash: createHash("sha256")
					.update(JSON.stringify(o))
					.digest("hex"),
				supersedes:
					prior.some((p) => p.id === o.id) && previous?.id !== bundle.id
						? `${previous?.id}/${o.id}`
						: (previous?.objectMetadata?.[o.id]?.supersedes ?? null),
			},
		]),
	);
	return bundle;
}
