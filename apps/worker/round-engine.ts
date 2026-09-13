import { splitTokenReservation } from "../../packages/research/budget";
import { outputLimit } from "../../packages/llm-provider";
import { pdfReadNotice } from "../../packages/core/pdf";
import { compactDirectionContext } from "../../packages/research/context";
import {
	changedMemoryClaims,
	selectMemoryDependencies,
} from "../../packages/memory/delta";
import { memoryPartitions } from "../../packages/memory/partition";
import {
	updateGaps,
	combineReviews,
	type MemoryGap,
} from "../../packages/memory/gaps";
import {
	directionSchema,
	questionContract,
	researchSatisfied,
	actionBudgetConstraint,
	actionSelectionSchema,
	initialQuestions,
	questionBrief,
	updateQuestions,
	applyCoverage,
	sourceAttempts,
	validateAction,
	actionKey,
	digest,
	pendingSourceBatch,
	rangeSelectionSchema,
	type Question,
	type ActionCandidate,
} from "../../packages/research/direction";
import { sourceIndex, readSourceRange } from "../../packages/memory/source";
import { fits, evaluationHold } from "../../packages/research/budget";
import {
	memoryContext,
	memoryStageHash,
	allocateMemoryIds,
	emptyBundle,
	memoryInput,
	memorySchemas,
	memoryReviewResponse,
	validateMemory,
	memoryCandidates,
	memoryReviewPass,
	drillMemory,
	type MemoryBundle,
} from "../../packages/memory";
import { LlmFetchError } from "llm-fetch";
import { SearchProviderError } from "../../packages/search-provider";
import { summariesSchema } from "../../packages/research/rounds";
import { finalHold } from "../../packages/research/budget";
import {
	exportArtifact,
	reportBody,
	validateClaims,
} from "../../packages/artifact";
import {
	assessStructure,
	REVIEW_VERSION,
	reviewPass,
	reviewSchema,
	reviewScore,
} from "../../packages/artifact/quality";
import {
	reportCandidates,
	researchInput,
} from "../../packages/artifact/research";
import {
	type Artifact,
	type Claim,
	claimResponse,
	type Evidence,
	type Job,
	type Query,
	reportResponse,
	type Snapshot,
} from "../../packages/contracts";
import {
	canonicalUrl,
	locateEvidence,
	normalize,
	selectSections,
	terminal,
} from "../../packages/core";
import { BudgetExceeded, LeaseLost, type Task, uid } from "../../packages/db";
import { tokenReservation } from "../../packages/llm-provider";
import { prompt, type PromptKind } from "../../packages/prompts";
import {
	type Brief,
	type Evaluation,
	briefSchema,
	validatePreparedBrief,
	chooseOpportunities,
	exactIds,
	type Round,
	selectionSchema,
	validateEvaluation,
	type WorkItem,
} from "../../packages/research/rounds";
import type { Engine, Providers } from "./engine";

// The control task owns all transitions. Each tick performs at most one provider call.
export class RoundEngine {
	constructor(
		private host: Engine,
		private providers: Providers,
		private root: string,
	) {}
	get store() {
		return this.host.store;
	}
	item(
		job: Job,
		roundId: string,
		kind: string,
		payload: Record<string, unknown> = {},
		dependsOn: string[] = [],
		priority = 50,
	): WorkItem {
		return {
			id: uid(),
			jobId: job.id,
			roundId,
			kind,
			payload,
			dependsOn,
			priority,
			status: "pending",
			reason: kind,
			revision: 0,
			nextAt: 0,
			createdAt: Date.now(),
		};
	}
	enqueue(
		job: Job,
		roundId: string,
		kind: string,
		payload: Record<string, unknown> = {},
		deps: string[] = [],
		priority = 50,
	) {
		const parent = this.store
			.workItems(job.id)
			.find((i) => i.roundId === roundId && i.payload.actionId);
		const w = this.item(
			job,
			roundId,
			kind,
			{
				...(parent
					? {
							actionId: parent.payload.actionId,
							questionIds: parent.payload.questionIds,
						}
					: {}),
				...payload,
			},
			deps,
			priority,
		);
		this.store.saveWork(w);
		return w;
	}
	meta(job: Job, changes: Record<string, unknown> = {}) {
		const old = this.store.record<Record<string, unknown>>(
			job.id,
			"research",
			"state",
		);
		this.store.put(job.id, "research", "state", {
			id: "state",
			revision: 0,
			sufficient: null,
			reason: "",
			...old,
			...changes,
		});
	}
	saveRound(job: Job, r: Round) {
		this.store.put(job.id, "round", r.id, r);
	}
	complete(t: Task, w: WorkItem, result: unknown, fn = () => {}) {
		this.store.commit(
			t,
			() => {
				w.status = (result as { unread?: boolean })?.unread
					? "skipped"
					: "succeeded";
				w.result = result;
				if (w.payload.actionId) {
					const action = this.store.record<Record<string, unknown>>(
						t.job_id,
						"action",
						String(w.payload.actionId),
					);
					if (
						action &&
						!["succeeded", "failed", "unknown", "cancelled"].includes(
							String(action.status),
						)
					) {
						const done =
							action.operation === "search"
								? w.kind === "search_poll"
								: ["read_source", "fetch_source"].includes(
											String(action.operation),
										)
									? w.kind === "check_claims"
									: w.kind === "evaluate";
						this.store.put(t.job_id, "action", String(w.payload.actionId), {
							...action,
							status: (result as { unread?: boolean })?.unread
								? "failed"
								: done
									? "succeeded"
									: "running",
							lastWorkId: w.id,
						});
					}
				}
				w.revision++;
				this.store.saveWork(w);
				fn();
				this.store.saveWork(w);
				this.store.event(t.job_id, "work.completed", {
					id: w.id,
					kind: w.kind,
					roundId: w.roundId,
				});
			},
			{ phase: "round" },
		);
	}
	finishHold(job: Job) {
		return finalHold(job);
	}

	async llm(t: Task, w: WorkItem, job: Job, kind: PromptKind, input: unknown) {
		const text = JSON.stringify(input);
		const invocation = prompt(kind, text);
		if (
			Buffer.byteLength(invocation.system + invocation.content.text) >
			Number(job.config.providerInputBytes ?? 200000)
		)
			throw Error("PROVIDER_INPUT_LIMIT");
		this.store.atomic(() => {
			this.store.assertLease(t);
			w.payload.inputRevision = this.store.research(job.id).revision;
			w.payload.promptHash = digest({
				role: invocation.role,
				system: invocation.system,
				text: invocation.content.text,
			});
			this.store.saveWork(w);
		});
		const amount =
			tokenReservation(text, kind) +
			(job.config.llmProvider === "codex" ? 20000 : 0);
		return this.host.operation(
			t,
			`round:${w.id}:${w.roundId === "final" && kind.startsWith("memory_") ? "memory-final:" : ""}${kind}:${w.payload.pass ?? 0}:${w.payload.repair ?? 0}`,
			{ requests: 1, ...splitTokenReservation(amount, outputLimit(kind)) },
			() =>
				this.providers.llm.complete(
					kind,
					text,
					AbortSignal.any([this.signal, AbortSignal.timeout(180000)]),
				),
		);
	}
	memoryDetail(job: Job) {
		const detail = this.store.detail(job.id);
		if (!detail) throw new Error("JOB_MISSING");
		// The UI detail intentionally returns a window. Memory must see all recorded decisions.
		detail.events = [];
		for (let after = 0; ; ) {
			const page = this.store.events(job.id, after);
			detail.events.push(...page);
			if (page.length < 500) break;
			after = page[page.length - 1].id;
		}
		return detail;
	}
	continueSource(job: Job, round: Round, work: WorkItem, read?: WorkItem) {
		const result = read?.result as
			| { sourceId?: string; passages?: { start: number; length: number }[] }
			| undefined;
		if (
			job.config.researchControlVersion !== 2 ||
			!result?.sourceId ||
			!result.passages?.length
		)
			return;
		const next = this.enqueue(
			job,
			round.id,
			"read",
			{
				sourceId: result.sourceId,
				actionId: read?.payload.actionId,
				questionIds: read?.payload.questionIds,
			},
			[work.id],
			work.priority,
		);
		const check = this.enqueue(
			job,
			round.id,
			"check_claims",
			{ readId: next.id },
			[next.id],
			work.priority,
		);
		for (const evaluation of this.store
			.workItems(job.id)
			.filter(
				(item) =>
					item.kind === "evaluate" &&
					item.roundId === round.id &&
					item.status === "pending",
			)) {
			evaluation.dependsOn.push(check.id);
			this.store.saveWork(evaluation);
		}
	}
	async checkpoint(
		t: Task,
		w: WorkItem,
		job: Job,
	): Promise<MemoryBundle | null> {
		if (job.config.memoryVersion !== 1) return null;
		const detail = this.memoryDetail(job);
		const source = memoryInput(detail);
		if (w.payload.repairAction)
			source.inputHash = digest({
				inputHash: source.inputHash,
				repairAction: w.payload.repairAction,
			});
		const cached = w.payload.memoryCheckpoint as
			| { hash: string; stage: number; bundle: MemoryBundle; attempt: number }
			| undefined;
		let state = cached?.hash === source.inputHash ? cached : undefined;
		if (!state) {
			delete w.payload.memoryPartition;
			const existing = detail.memory?.find(
				(m) => m.inputHash === source.inputHash && m.status === "reviewed",
			);
			if (existing) return existing;
			state = {
				hash: source.inputHash,
				stage: 0,
				bundle: {
					...emptyBundle(detail, detail.memory?.[0]),
					knowledge: detail.memory?.[0]?.knowledge ?? [],
					episodes: detail.memory?.[0]?.episodes ?? [],
					concepts: detail.memory?.[0]?.concepts ?? [],
					relations: detail.memory?.[0]?.relations ?? [],
					id: `memory:${source.inputHash}`,
					inputHash: source.inputHash,
				},
				attempt: 0,
			};
		}
		if (state.stage === 4) return state.bundle;
		if (
			job.config.researchControlVersion === 2 &&
			w.kind === "evaluate" &&
			!source.evidence.length &&
			!w.payload.repairAction
		) {
			// With no factual evidence there is nothing to distill for direction
			// selection. Preserve actual events now; distill once at finalization.
			const bundle = emptyBundle(detail, detail.memory?.[0]);
			bundle.structuralIssues = validateMemory(bundle, detail);
			if (bundle.structuralIssues.length) throw Error("MEMORY_INVALID");
			state = { ...state, stage: 4, bundle };
			this.store.commit(
				t,
				() => {
					this.store.put(job.id, "memory", bundle.id, bundle);
					w.payload.memoryCheckpoint = state;
					this.store.saveWork(w);
					this.store.event(job.id, "memory.distillation_deferred", {
						memoryId: bundle.id,
						reason: "zero_evidence",
						events: bundle.events.length,
					});
				},
				{ phase: "round" },
			);
			return bundle;
		}
		const kinds = [
			"memory_knowledge",
			"memory_episode",
			"memory_concepts",
			"memory_review",
		] as const;
		const kind = kinds[state.stage];
		const sourceBundle = state.bundle;
		const stageHash = memoryStageHash(kind, detail, sourceBundle);
		const targetPrefixes =
			kind === "memory_knowledge"
				? ["k:"]
				: kind === "memory_episode"
					? ["ep:"]
					: ["c:", "k:"];
		const unneededRepair =
			state.attempt > 0 &&
			kind !== "memory_review" &&
			!(sourceBundle.review?.defects ?? []).some(
				(d) =>
					d.targetId === "bundle" ||
					targetPrefixes.some((p) => d.targetId.startsWith(p)),
			);
		const previous = unneededRepair
			? sourceBundle
			: detail.memory?.find((m) => m.stageHashes?.[kind] === stageHash);
		const incremental = job.config.researchControlVersion === 2;
		const emptyStage =
			incremental &&
			(((kind === "memory_knowledge" || kind === "memory_concepts") &&
				!source.evidence.length) ||
				(kind === "memory_episode" && !source.events.length));
		if (
			incremental &&
			(emptyStage ||
				unneededRepair ||
				(previous && state.attempt === 0 && !w.payload.repairAction))
		) {
			if (kind === "memory_knowledge")
				sourceBundle.knowledge = emptyStage ? [] : (previous?.knowledge ?? []);
			if (kind === "memory_episode")
				sourceBundle.episodes = emptyStage ? [] : (previous?.episodes ?? []);
			if (kind === "memory_concepts") {
				sourceBundle.concepts = emptyStage ? [] : (previous?.concepts ?? []);
				sourceBundle.relations = emptyStage ? [] : (previous?.relations ?? []);
			}
			if (kind === "memory_review") {
				sourceBundle.review = previous?.review ?? null;
				sourceBundle.status = "reviewed";
			}
			sourceBundle.stageHashes = {
				...sourceBundle.stageHashes,
				[kind]: stageHash,
			};
			allocateMemoryIds(sourceBundle, previous);
			state.stage++;
			this.store.commit(
				t,
				() => {
					this.store.put(job.id, "memory", sourceBundle.id, sourceBundle);
					w.payload.memoryCheckpoint = state;
					w.status = "pending";
					this.store.saveWork(w);
				},
				{ phase: "round" },
			);
			return null;
		}
		const priorBundle = detail.memory?.find(
			(m) => m.id !== sourceBundle.id && m.status === "reviewed",
		);
		const deltaClaims =
			job.config.researchControlVersion === 2 &&
			(kind === "memory_knowledge" || kind === "memory_concepts")
				? changedMemoryClaims(detail, state.bundle, priorBundle)
				: null;
		const selectedDetail = deltaClaims
			? {
					...detail,
					claims: detail.claims.filter((c) => deltaClaims.includes(c.id)),
				}
			: detail;
		const selectedBundle = deltaClaims
			? selectMemoryDependencies(state.bundle, deltaClaims)
			: state.bundle;
		const partitions = memoryPartitions(
			kind,
			selectedDetail,
			selectedBundle,
			deltaClaims && priorBundle
				? selectMemoryDependencies(priorBundle, deltaClaims)
				: detail.memory?.[0],
			Number(job.config.memoryContextBytes ?? 160000),
		);
		const partitionIndex = Number(w.payload.memoryPartition ?? 0);
		const input = {
			...partitions[partitionIndex],
			priorValidationError: w.payload.validationError ?? null,
			repairRequest: w.payload.repairAction ?? null,
			gaps: this.store
				.all<MemoryGap>(job.id, "gap")
				.filter((g) => g.state === "open"),
			...(state.attempt
				? {
						surroundingEvidence: sourceBundle.evidence.map((e) =>
							drillMemory(sourceBundle, detail, e.evidenceId),
						),
					}
				: {}),
		};
		if (
			new TextEncoder().encode(JSON.stringify(input)).length >
			Number(job.config.memoryContextBytes ?? 160000)
		)
			throw new Error("MEMORY_CONTEXT_LIMIT");
		const response = await this.llm(t, w, job, kind, input);
		const parsed = memorySchemas[kind].parse(JSON.parse(response.text));
		const bundle = {
			...state.bundle,
			...(kind === "memory_review" ? {} : parsed),
			stageHashes: { ...state.bundle.stageHashes, [kind]: stageHash },
		};
		if (job.config.researchControlVersion === 2 && kind !== "memory_review")
			allocateMemoryIds(bundle, state.bundle);
		if (partitions.length > 1 && kind !== "memory_review" && !deltaClaims) {
			const merge = <T extends { id: string }>(old: T[], next: T[]) => [
				...old.filter((o) => !next.some((n) => n.id === o.id)),
				...next,
			];
			bundle.knowledge = merge(state.bundle.knowledge, bundle.knowledge);
			bundle.episodes = merge(state.bundle.episodes, bundle.episodes);
			bundle.concepts = merge(state.bundle.concepts, bundle.concepts);
			bundle.relations = [
				...new Map(
					[...state.bundle.relations, ...bundle.relations].map((r) => [
						JSON.stringify(r),
						r,
					]),
				).values(),
			];
		}
		if (deltaClaims) {
			const activeClaims =
				partitions.length > 1
					? (input.claims ?? []).map((c) => c.id)
					: deltaClaims;
			if (kind === "memory_knowledge")
				bundle.knowledge = [
					...state.bundle.knowledge.filter(
						(o) => !o.claimIds.some((id) => activeClaims.includes(id)),
					),
					...bundle.knowledge,
				];
			if (kind === "memory_concepts") {
				bundle.concepts = [
					...state.bundle.concepts.filter(
						(o) => !o.claimIds.some((id) => activeClaims.includes(id)),
					),
					...bundle.concepts,
				];
				const ids = new Set(
					[...bundle.knowledge, ...bundle.episodes, ...bundle.concepts].map(
						(o) => o.id,
					),
				);
				bundle.relations = [
					...state.bundle.relations.filter(
						(r) =>
							!r.claimIds.some((id) => activeClaims.includes(id)) &&
							ids.has(r.from) &&
							ids.has(r.to),
					),
					...bundle.relations,
				];
			}
		}
		bundle.structuralIssues = validateMemory(bundle, detail);
		if (bundle.structuralIssues.length)
			throw new Error(`MEMORY_INVALID:${bundle.structuralIssues.join(",")}`);
		if (this.store.research(job.id).revision !== source.revision)
			throw new Error("RESEARCH_REVISION_CHANGED");
		const lastPartition = partitionIndex + 1 >= partitions.length;
		if (!lastPartition) delete bundle.stageHashes[kind];
		state = { ...state, bundle, stage: state.stage + (lastPartition ? 1 : 0) };
		if (kind === "memory_review") {
			const reviewed = memoryReviewResponse.parse(parsed);
			const accumulated = partitionIndex > 0 ? state.bundle.review : null;
			bundle.review = combineReviews(accumulated, reviewed);
			bundle.structuralIssues = validateMemory(bundle, detail);
			if (bundle.structuralIssues.length)
				throw new Error(`MEMORY_INVALID:${bundle.structuralIssues.join(",")}`);
			bundle.status = lastPartition ? "reviewed" : "draft";
			const repair = bundle.review.defects.some(
				(d) => d.route === "revise_memory" || d.route === "inspect_evidence",
			);
			this.store.assertLease(t);
			// Preserve review attempts; a revision never overwrites its predecessor.

			if (
				repair &&
				state.attempt === 0 &&
				lastPartition &&
				job.config.researchControlVersion !== 2
			) {
				state = {
					hash: source.inputHash,
					stage: 0,
					attempt: 1,
					bundle: {
						...bundle,
						id: `${bundle.id}:repair`,
						supersedes: bundle.id,
						status: "draft",
						asOf: new Date().toISOString(),
					},
				};
			}
		}
		const savedState = state;
		this.store.commit(
			t,
			() => {
				this.store.put(job.id, "memory", bundle.id, bundle);
				if (
					kind === "memory_review" &&
					bundle.review &&
					job.config.researchControlVersion === 2
				)
					for (const gap of updateGaps(
						this.store.all<MemoryGap>(job.id, "gap"),
						bundle.review,
						bundle.id,
					))
						this.store.put(job.id, "gap", gap.id, gap);
				w.payload.memoryCheckpoint = savedState;
				w.payload.memoryPartition = lastPartition ? 0 : partitionIndex + 1;
				delete w.payload.repair;
				w.payload.pass = Number(w.payload.pass ?? 0) + 1;
				w.status = "pending";
				this.store.saveWork(w);
				this.store.event(job.id, "memory.stage_completed", {
					kind,
					memoryId: bundle.id,
					stage: savedState.stage,
					attempt: savedState.attempt,
					review: kind === "memory_review" ? bundle.review : undefined,
				});
			},
			{ phase: "round" },
		);
		return null;
	}

	async direction(
		t: Task,
		w: WorkItem,
		job: Job,
		r: Round,
		memory: MemoryBundle,
	) {
		const detail = this.memoryDetail(job);
		const revision = this.store.research(job.id).revision;
		if (pendingSourceBatch(detail.research?.items ?? []))
			throw Error("SOURCE_BATCH_UNSETTLED");
		const brief = detail.memoryBrief;
		if (!brief) throw Error("BRIEF_MISSING");
		let questions = this.store.all<Question>(job.id, "question");
		if (!questions.length) questions = initialQuestions(brief, revision);
		const claims = detail.claims.filter((c) => c.accepted);
		let input = {
			originalRequest: job.topic,
			completedWorkIds: (detail.research?.items ?? [])
				.filter((i) => i.status === "succeeded")
				.map((i) => i.id),
			priorValidationError: w.payload.validationError ?? null,
			brief: questionBrief(questions),
			questions,
			claims: claims.map((c) => ({
				id: c.id,
				text: c.text,
				evidence: detail.evidence.filter((e) => c.evidenceIds.includes(e.id)),
			})),
			memory: {
				knowledge: memory.knowledge.map((k) => ({
					id: k.id,
					title: k.title,
					claimIds: k.claimIds,
				})),
				episodes: memory.episodes.map((e) => ({
					id: e.id,
					title: e.title,
					eventIds: e.eventIds,
					claimIds: e.claimIds,
				})),
				concepts: memory.concepts.map((c) => ({
					id: c.id,
					name: c.name,
					claimIds: c.claimIds,
				})),
				defects: memory.review?.defects ?? [],
			},
			sourceAttempts: sourceAttempts(detail),
			sources: detail.sources.map((s) => sourceIndex(s)),
			readRanges: (detail.research?.items ?? [])
				.filter((i) => i.kind === "read")
				.map((i) => {
					const result = i.result as Record<string, unknown> | undefined;
					return {
						id: i.id,
						sourceId: result?.sourceId ?? i.payload.sourceId,
						start: result?.start ?? i.payload.start,
						end: result?.end ?? i.payload.end,
						status: i.status,
						unread: result?.unread,
					};
				}),
			contextPolicy:
				"Full verified claims and exact evidence are retained. Memory objects are navigation metadata only; full object bodies remain saved and can be revised via repair actions. Discovery metadata is not evidence.",
			unattemptedDiscoveries: (detail.research?.rounds ?? [])
				.flatMap((round) => round.candidates)
				.filter(
					(c) =>
						!(detail.research?.items ?? []).some(
							(w) => w.kind === "fetch" && w.payload.url === c.url,
						),
				),
			userCandidates: detail.research?.candidates ?? [],
			previousQueries: detail.queries.map((q) => q.query),
			previousActions: this.store
				.all<Record<string, unknown>>(job.id, "action")
				.map((a) => ({
					id: a.id,
					operation: a.operation,
					questionIds: a.questionIds,
					targetId: a.targetId,
					expectedDelta: a.expectedDelta,
					status: a.status,
					reason: a.reason,
					constraint: a.constraint,
				})),
			reportDefects: w.payload.reportDefects ?? null,
			gaps: this.store
				.all<MemoryGap>(job.id, "gap")
				.filter((g) => g.state === "open"),
			remaining: Object.fromEntries(
				Object.entries(job.budget).map(([k, v]) => [
					k,
					v - (job.usage[k as keyof typeof job.usage] ?? 0),
				]),
			),
		};
		const context = compactDirectionContext(
			input,
			Number(job.config.providerInputBytes ?? 200000),
			(value) => {
				const p = prompt("research_direction_review", JSON.stringify(value));
				return Buffer.byteLength(p.system + p.content.text);
			},
		);
		input = context.input;
		if (!context.fits) {
			this.complete(
				t,
				w,
				{
					reason: "review_context_capacity",
					inputHash: digest(input),
					bytes: context.bytes,
				},
				() => {
					this.meta(job, { sufficient: false });
					this.store.event(job.id, "research.context_capacity", {
						fullBytes: context.fullBytes,
						bytes: context.bytes,
						evidenceOmitted: false,
					});
					this.finalize(job, "review_context_capacity");
				},
			);
			return;
		}
		const inputHash = digest({ ...input, remaining: undefined });
		const cached = w.payload.direction as
			| {
					inputHash: string;
					proposal: ReturnType<typeof directionSchema.parse>;
					questions: Question[];
					changedQuestionIds?: string[];
			  }
			| undefined;
		if (!cached || cached.inputHash !== inputHash) {
			const response = await this.llm(
				t,
				w,
				job,
				"research_direction_review",
				input,
			);
			const proposal = directionSchema.parse(JSON.parse(response.text));
			validateEvaluation(
				proposal.evaluation,
				input.brief,
				claims.map((c) => c.id),
			);
			if (
				proposal.actions.some((a) =>
					a.dependsOn.some((id) => !input.completedWorkIds.includes(id)),
				)
			)
				throw Error(
					"ACTION_DEPENDENCY_REFERENCE: use only completedWorkIds; independent alternatives need no dependency",
				);
			if (
				proposal.actions.some(
					(a) =>
						a.operation === "read_source" &&
						!detail.sources.some(
							(s) =>
								s.id === a.targetId &&
								a.end > a.start &&
								a.end <= s.text.length,
						),
				)
			)
				throw Error(
					"ACTION_SOURCE_REFERENCE: a failed fetch is not an available snapshot",
				);
			const changed = updateQuestions(
				questions,
				proposal.questionUpdates,
				claims.map((c) => c.id),
				revision,
			);
			const assessed = applyCoverage(questions, proposal.evaluation, revision);
			const changedQuestionIds = changed.questions
				.filter((q) => {
					const old = questions.find((x) => x.id === q.id);
					return !old || questionContract(old) !== questionContract(q);
				})
				.map((q) => q.id);
			if (
				changedQuestionIds.length &&
				Number(w.payload.questionRevisionPass ?? 0) >= 2
			)
				throw Error("QUESTION_REVISION_LIMIT");
			questions = changed.questions.map((q) =>
				changedQuestionIds.includes(q.id)
					? {
							...q,
							status: "open" as const,
							claimIds: [],
							unknowns: [
								"Question contract changed; fresh evaluation required",
							],
						}
					: { ...q, ...assessed.find((x) => x.id === q.id) },
			);

			proposal.actions = proposal.actions.map((a) => ({
				...a,
				id: `action:${digest({ inputHash, a }).slice(0, 24)}`,
				questionIds: a.questionIds.map((id) => changed.aliases.get(id) ?? id),
			}));
			if (
				new Set(proposal.actions.map((a) => a.id)).size !==
				proposal.actions.length
			)
				throw Error("DUPLICATE_ACTION");
			if (this.store.research(job.id).revision !== revision)
				throw Error("RESEARCH_REVISION_CHANGED");
			this.store.commit(
				t,
				() => {
					w.payload.direction = {
						inputHash,
						proposal,
						questions,
						changedQuestionIds,
					};
					w.payload.pass = Number(w.payload.pass ?? 0) + 1;
					w.status = "pending";
					this.store.saveWork(w);
				},
				{ phase: "round" },
			);
			return;
		}
		questions = cached.questions;
		const proposal = cached.proposal;
		if (cached.changedQuestionIds?.length) {
			this.complete(
				t,
				w,
				{
					questionRevision: cached.changedQuestionIds,
					discardedEvaluation: proposal.evaluation,
				},
				() => {
					for (const q of questions)
						this.store.put(job.id, "question", q.id, q);
					this.store.put(job.id, "brief", "brief", {
						id: "brief",
						...questionBrief(questions),
					});
					this.store.put(job.id, "question_history", `${revision}:${w.id}`, {
						id: `${revision}:${w.id}`,
						questions,
					});
					this.meta(job, { sufficient: false });
					this.store.event(job.id, "research.questions_revised", {
						questionIds: cached.changedQuestionIds,
						requiresReevaluation: true,
					});
					this.enqueue(
						job,
						r.id,
						"evaluate",
						{
							questionRevisionPass:
								Number(w.payload.questionRevisionPass ?? 0) + 1,
						},
						[],
						0,
					);
				},
			);
			return;
		}
		const sufficient = researchSatisfied(questions, proposal.evaluation);
		const freshForSelection = this.store.getJob(job.id)!;

		const history = this.store.all<{ key: string; status: string }>(
			job.id,
			"action",
		);
		const candidateChecks = proposal.actions.map((action) => ({
			id: action.id,
			constraint:
				((w.payload.rejectedSelectionIds as string[] | undefined)?.includes(
					action.id,
				)
					? "selection_rejected"
					: null) ??
				validateAction(
					action,
					action.operation === "search" ? `pending-query:${action.id}` : "",
					detail,
					questions,
					history,
				) ??
				(action.purpose === "supplement" && !sufficient
					? "core_unmet"
					: null) ??
				(["revise_memory", "inspect_content", "decide_direction"].includes(
					action.operation,
				) &&
				this.store
					.workItems(job.id)
					.some((i) => i.payload.repairAction && i.roundId === r.id)
					? "repair_limit"
					: null) ??
				actionBudgetConstraint(
					freshForSelection,
					action,
					r.number,
					freshForSelection.mode === "live" && action.operation === "search"
						? this.host.requestCost(freshForSelection)
						: 0,
				),
		}));
		const response = await this.llm(t, w, job, "research_action_select", {
			originalRequest: input.originalRequest,
			knownClaims: input.claims.map((claim) => ({
				id: claim.id,
				text: claim.text,
			})),
			sourceAttempts: input.sourceAttempts,
			unattemptedDiscoveries: input.unattemptedDiscoveries,
			previousQueries: input.previousQueries,
			previousActions: input.previousActions.map((value) => {
				const action = value as Record<string, unknown>;
				return {
					id: action.id,
					operation: action.operation,
					questionIds: action.questionIds,
					targetId: action.targetId,
					expectedDelta: action.expectedDelta,
					status: action.status,
					reason: action.reason,
				};
			}),
			gaps: input.gaps,
			remaining: input.remaining,
			inputScope:
				"Selection metadata after the verified direction review; full source evidence remains in the saved review input and is not re-summarized here.",
			questions,
			completionAllowed: sufficient,
			actions: proposal.actions,
			candidateChecks,
			admissibleActionIds: candidateChecks
				.filter((c) => !c.constraint)
				.map((c) => c.id),
			evaluation: proposal.evaluation,
		});
		const selection = actionSelectionSchema.parse(JSON.parse(response.text));
		exactIds(
			proposal.actions.map((a) => a.id),
			selection.reasons.map((x) => x.id),
		);
		const selected = proposal.actions.find(
			(a) => a.id === selection.selectedId,
		);
		if ((selection.decision === "adopt") !== !!selected)
			throw Error("INVALID_ACTION_SELECTION");

		let constraint = selected
			? validateAction(selected, selection.query, detail, questions, history)
			: null;
		if (
			selected &&
			["revise_memory", "inspect_content", "decide_direction"].includes(
				selected.operation,
			) &&
			this.store
				.workItems(job.id)
				.some((i) => i.payload.repairAction && i.roundId === r.id)
		)
			constraint = "repair_limit";
		const fresh = this.store.getJob(job.id)!;
		if (selected && !constraint)
			constraint =
				candidateChecks.find((c) => c.id === selected.id)?.constraint ??
				actionBudgetConstraint(
					fresh,
					selected,
					r.number,
					fresh.mode === "live" && selected.operation === "search"
						? this.host.requestCost(fresh)
						: 0,
				);

		if (
			selected &&
			constraint &&
			!((w.payload.rejectedSelectionIds as string[]) ?? []).includes(
				selected.id,
			) &&
			candidateChecks.some((c) => c.id !== selected.id && !c.constraint)
		) {
			this.store.commit(
				t,
				() => {
					w.payload.rejectedSelectionIds = [
						...((w.payload.rejectedSelectionIds as string[]) ?? []),
						selected.id,
					];
					w.payload.pass = Number(w.payload.pass ?? 0) + 1;
					w.payload.rejectedSelections = [
						...((w.payload.rejectedSelections as unknown[]) ?? []),
						{
							actionId: selected.id,
							reason: constraint,
							alternativesRemain: true,
						},
					];
					w.status = "pending";
					this.store.saveWork(w);
				},
				{ phase: "round" },
			);
			return;
		}
		if (
			selection.decision === "wait_approval" &&
			!input.sourceAttempts.some((s) => s.state === "approval_pending")
		)
			throw Error("APPROVAL_STATE_UNSUPPORTED");
		if (selected?.operation !== "search" && selection.query.trim())
			throw Error("UNEXPECTED_SEARCH_QUERY");
		if (selection.decision === "satisfied" && !sufficient)
			throw Error("UNSUPPORTED_COMPLETION");
		if (this.store.research(job.id).revision !== revision)
			throw Error("RESEARCH_REVISION_CHANGED");
		this.complete(t, w, { proposal, selection, constraint }, () => {
			for (const rejected of (w.payload.rejectedSelections as Record<
				string,
				unknown
			>[]) ?? [])
				this.store.event(job.id, "research.selection_rejected", rejected);
			for (const q of questions) this.store.put(job.id, "question", q.id, q);
			this.store.put(job.id, "question_history", `${revision}:${w.id}`, {
				id: `${revision}:${w.id}`,
				questions,
			});
			this.store.put(job.id, "brief", "brief", {
				id: "brief",
				...questionBrief(questions),
			});
			for (const a of proposal.actions)
				this.store.put(job.id, "action", a.id, {
					...a,
					key: actionKey(a, a.id === selected?.id ? selection.query : ""),
					inputHash,
					revision,
					status: a.id === selected?.id && !constraint ? "queued" : "cancelled",
					reason: selection.reasons.find((x) => x.id === a.id)?.reason,
					constraint,
				});
			const decision = {
				id: w.id,
				inputHash,
				revision,
				selection,
				constraint,
				promptHash: digest(response.audit),
				memoryId: memory.id,
			};
			this.store.put(job.id, "decision", w.id, decision);
			this.store.event(job.id, "research.decision", decision);
			r.state = "evaluated";
			r.evaluation = proposal.evaluation;
			this.saveRound(job, r);
			this.meta(job, {
				sufficient:
					sufficient &&
					!["unmet", "wait_approval"].includes(selection.decision),
				decisionLocked: false,
			});
			if (selected && !constraint) {
				if (selected.operation === "search") {
					this.startRound(
						fresh,
						[selection.query],
						selected.purpose === "supplement" ? "supplement" : "core",
						selection.reason,
					);
					const nextRound = this.store.all<Round>(job.id, "round").at(-1)!;
					for (const item of this.store
						.workItems(job.id)
						.filter((i) => i.roundId === nextRound.id)) {
						item.payload.actionId = selected.id;
						item.payload.questionIds = selected.questionIds;
						this.store.saveWork(item);
					}
				} else if (selected.operation === "fetch_source") {
					const candidate = detail
						.research!.rounds.flatMap((round) => round.candidates)
						.find((c) => c.id === selected.targetId)!;
					const fetch = this.enqueue(fresh, r.id, "fetch", {
						url: candidate.url,
						title: candidate.title,
						candidateId: candidate.id,
						selectionReason: selection.reason,
						actionId: selected.id,
						questionIds: selected.questionIds,
					});
					const read = this.enqueue(
						fresh,
						r.id,
						"read",
						{
							fetchId: fetch.id,
							candidateId: candidate.id,
							actionId: selected.id,
							questionIds: selected.questionIds,
						},
						[fetch.id],
					);
					const check = this.enqueue(
						fresh,
						r.id,
						"check_claims",
						{ readId: read.id, actionId: selected.id },
						[read.id],
					);
					this.enqueue(fresh, r.id, "evaluate", {}, [check.id], 0);
				} else if (selected.operation === "read_source") {
					const source = detail.sources.find(
						(s) => s.id === selected.targetId,
					)!;
					readSourceRange(
						source,
						source.hash,
						selected,
						Number(job.config.sourceRangeBytes ?? 12000),
					);
					const read = this.enqueue(fresh, r.id, "read", {
						sourceId: source.id,
						start: selected.start,
						end: selected.end,
						actionId: selected.id,
						questionIds: selected.questionIds,
					});
					const check = this.enqueue(
						fresh,
						r.id,
						"check_claims",
						{ readId: read.id, actionId: selected.id },
						[read.id],
					);
					this.enqueue(fresh, r.id, "evaluate", {}, [check.id], 0);
				} else {
					// A distinct repair gets one new checkpoint; unchanged repeats are rejected by actionKey.
					this.enqueue(
						fresh,
						r.id,
						"evaluate",
						{ repairAction: selected, actionId: selected.id, pass: 1 },
						[],
						0,
					);
				}
			} else {
				const reason =
					constraint ??
					(selection.decision === "wait_approval"
						? "approval_pending"
						: sufficient && selection.decision === "satisfied"
							? "satisfied"
							: "no_valuable_candidate");
				for (const q of questions.filter((q) => q.status === "open"))
					this.store.put(job.id, "question", q.id, {
						...q,
						status: "unresolved",
					});
				this.finalize(fresh, reason);
			}
		});
	}

	signal: AbortSignal = new AbortController().signal;
	startRound(
		job: Job,
		queries: string[],
		purpose: Round["purpose"],
		reason: string,
	) {
		const rounds = this.store.all<Round>(job.id, "round");
		const number = rounds.length + 1;
		if (number > job.budget.rounds) throw new BudgetExceeded();
		const r: Round = {
			id: `r${number}`,
			number,
			purpose,
			state: "searching",
			queries,
			selected: [],
			candidates: [],
			reason,
			revision: 0,
			createdAt: Date.now(),
		};
		this.saveRound(job, r);
		let last: string | undefined;
		for (const query of queries) {
			const q: Query = {
				id: uid(),
				query,
				depth: number - 1,
				score: 100,
				reason,
				status: "pending",
				known: "unverified",
			};
			this.store.put(job.id, "query", q.id, q);
			const w = this.enqueue(
				job,
				r.id,
				"search_submit",
				{ queryId: q.id, query },
				last ? [last] : [],
			);
			const poll = this.enqueue(
				job,
				r.id,
				"search_poll",
				{ queryId: q.id, submitId: w.id, poll: 0 },
				[w.id],
			);
			last = poll.id;
		}
		this.store.event(job.id, "round.started", {
			round: number,
			purpose,
			queries,
			reason,
		});
	}
	finalize(job: Job, reason: string) {
		const current = this.store.getJob(job.id) as Job;
		current.reason = reason;
		current.status = "finalizing";
		this.store.saveJob(current);
		this.meta(job, { reason, decisionLocked: false });
		if (
			!this.store
				.workItems(job.id)
				.some(
					(w) =>
						w.kind === "synthesize" &&
						w.status !== "cancelled" &&
						w.payload.researchRevision === this.store.research(job.id).revision,
				)
		)
			this.enqueue(job, "final", "synthesize", {
				researchRevision: this.store.research(job.id).revision,
			});
	}
	async step(t: Task, signal: AbortSignal) {
		this.signal = signal;
		let job = this.store.getJob(t.job_id) as Job;
		if (terminal(job.status)) {
			this.store.commit(t, () => {}, { phase: "round" }, true);
			return;
		}
		if (job.status === "cancel_requested") {
			this.store.commit(
				t,
				() => {
					job.status = "cancelled";
					job.reason = "user_cancelled";
					this.store.saveJob(job);
				},
				{ phase: "round" },
				true,
			);
			return;
		}
		if (!job.startedAt) {
			this.store.atomic(() => {
				this.store.assertLease(t);
				job.startedAt = Date.now();
				job.deadline = Date.now() + job.budget.wallMs;
				job.status = "running";
				this.store.saveJob(job);
				this.meta(job);
				const knowledge = this.enqueue(job, "initial", "lookup_knowledge");
				this.enqueue(job, "initial", "prepare_brief", {}, [knowledge.id]);
				this.store.event(job.id, "job.started", { engineVersion: 2 });
			});
		}
		job = this.store.getJob(job.id) as Job;
		if (Date.now() >= (job.deadline ?? Infinity)) {
			this.fallback(t, job, "time_budget");
			return;
		}
		const items = this.store.workItems(job.id);
		const w = items.find(
			(i) =>
				(i.status === "pending" || i.status === "running") &&
				i.nextAt <= Date.now() &&
				i.dependsOn.every((id) =>
					["succeeded", "failed", "skipped"].includes(
						items.find((x) => x.id === id)?.status ?? "",
					),
				),
		);
		if (!w) {
			this.store.commit(t, () => {}, { phase: "round" }, false, 250);
			return;
		}
		const finishAllowance = job.mode === "mock" ? 0 : 4 * 180000;
		if (
			w.roundId !== "final" &&
			Date.now() >= (job.deadline ?? Infinity) - finishAllowance
		) {
			if (this.store.slot().operation_key?.startsWith("pending:")) {
				this.store.sql
					.query("UPDATE execution_slot SET state='blocked' WHERE id=1")
					.run();
				this.fallback(t, job, "external_search_pending");
				return;
			}
			this.store.commit(
				t,
				() => {
					for (const item of this.store
						.workItems(job.id)
						.filter((i) => i.status === "pending" || i.status === "running")) {
						item.status = "skipped";
						item.error = "exploration_time_budget";
						this.store.saveWork(item);
					}
					this.finalize(job, "exploration_time_budget");
				},
				{ phase: "round" },
			);
			return;
		}
		let claimed = false;
		this.store.atomic(() => {
			this.store.assertLease(t);
			const latestItems = this.store.workItems(job.id);
			const selected = latestItems.find(
				(i) =>
					(i.status === "pending" || i.status === "running") &&
					i.nextAt <= Date.now() &&
					i.dependsOn.every((id) =>
						["succeeded", "failed", "skipped"].includes(
							latestItems.find((d) => d.id === id)?.status ?? "",
						),
					),
			);
			if (selected?.id !== w.id || selected.revision !== w.revision) return;
			claimed = true;
			w.status = "running";
			w.revision++;
			this.store.saveWork(w);
			this.store.event(job.id, "work.started", {
				id: w.id,
				kind: w.kind,
				roundId: w.roundId,
			});
		});
		if (!claimed) {
			this.store.commit(t, () => {}, { phase: "round" });
			return;
		}
		const r = this.store.record<Round>(job.id, "round", w.roundId);
		try {
			if (w.kind === "lookup_knowledge") {
				const result = await this.host.operation(
					t,
					`round:${w.id}:knowledge`,
					{ requests: 1 },
					() => this.providers.knowledge.lookup(job.topic, signal),
				);
				this.complete(t, w, result, () => {
					const current = this.store.getJob(job.id) as Job;
					current.config.knowledge = result;
					this.store.saveJob(current);
				});
				return;
			}
			if (w.kind === "prepare_brief") {
				const result = await this.llm(t, w, job, "prepare_brief", {
					originalRequest: job.topic,
					knowledge: job.config.knowledge,
					priorValidationError: w.payload.validationError ?? null,
					previousOutput: w.payload.previousBriefOutput ?? null,
				});
				this.store.atomic(() => {
					this.store.assertLease(t);
					w.payload.previousBriefOutput = result.text;
					this.store.saveWork(w);
				});
				const brief = validatePreparedBrief(JSON.parse(result.text), job.topic);

				this.complete(t, w, brief, () => {
					this.store.put(job.id, "brief", "brief", { id: "brief", ...brief });
					this.startRound(job, [job.topic], "core", "一次探索");
				});
				return;
			}
			if (w.kind === "search_submit") {
				const result = await this.host.operation(
					t,
					`round:${w.id}`,
					{
						queries: 1,
						requests: 1,
						costUsd: job.mode === "live" ? this.host.requestCost(job) : 0,
					},
					() => this.providers.search.submit(String(w.payload.query), signal),
				);
				if (!result.id) throw new Error("SEARCH_ID_MISSING");
				this.store.markExternal(t, `pending:${result.id}`);
				this.complete(t, w, result, () =>
					this.store.event(job.id, "query.selected", {
						id: w.payload.queryId,
						query: w.payload.query,
						reason: r?.reason,
					}),
				);
				return;
			}
			if (w.kind === "search_poll" && r) {
				const submission = this.store
					.workItems(job.id)
					.find((i) => i.id === w.payload.submitId)?.result as
					| { id: string }
					| undefined;
				if (!submission?.id) throw new Error("SEARCH_ID_MISSING");
				const poll = Number(w.payload.poll);
				if (poll >= 30) throw new Error("SEARCH_POLL_LIMIT");
				const result = await this.host.operation(
					t,
					`round:${w.id}:${poll}`,
					{
						requests: 1,
						tokens: job.config.searchProvider === "codex" ? 40000 : 0,
						costUsd: job.mode === "live" ? this.host.requestCost(job) : 0,
					},
					() =>
						this.providers.search.poll(submission.id, signal, {
							topic: job.topic,
							sources: this.store
								.all<Snapshot>(job.id, "source")
								.map((s) => ({ url: s.url, title: s.title })),
							failures: this.store
								.workItems(job.id)
								.filter((i) => i.kind === "fetch" && i.status === "failed")
								.map((i) => ({
									url: String(i.payload.url),
									reason: i.error ?? "fetch_failed",
								})),
						}),
				);
				if (!result.ready) {
					this.store.markExternal(t, `pending:${submission.id}`);
					this.store.commit(
						t,
						() => {
							w.status = "pending";
							w.payload.poll = poll + 1;
							w.nextAt =
								Date.now() + Math.min(30000, 1000 * 2 ** Math.min(poll, 5));
							this.store.saveWork(w);
						},
						{ phase: "round" },
						false,
						250,
					);
					return;
				}
				this.complete(t, w, result, () => {
					const urls = new Set(r.candidates.map((c) => c.url));
					for (const hit of result.hits.slice(0, 12)) {
						try {
							const url = canonicalUrl(hit.url);
							if (!urls.has(url)) {
								r.candidates.push({ ...hit, url, id: uid() });
								urls.add(url);
							}
						} catch {
							/* unsupported URL */
						}
					}
					const q = this.store.record<Query>(
						job.id,
						"query",
						String(w.payload.queryId),
					);
					if (q)
						this.store.put(job.id, "query", q.id, { ...q, status: "searched" });
					if (
						this.store
							.workItems(job.id)
							.filter((i) => i.roundId === r.id && i.kind === "search_poll")
							.every((i) => i.status === "succeeded")
					) {
						r.state = "selecting";
						this.enqueue(job, r.id, "select_sources");
					}
					this.saveRound(job, r);
					this.store.event(job.id, "search.completed", {
						queryId: q?.id,
						hits: result.hits.length,
					});
				});
				return;
			}
			if (w.kind === "select_sources" && r) {
				const batched = r.candidates.length > 8;
				const offset = Number(w.payload.offset ?? 0);
				const shortlist = (w.payload.shortlist ?? []) as string[];
				const pool = !batched
					? r.candidates
					: w.payload.finalPass
						? r.candidates.filter((c) => shortlist.includes(c.id))
						: r.candidates.slice(offset, offset + 8);
				const result = pool.length
					? await this.llm(t, w, job, "select_sources", {
							originalRequest: job.topic,
							readerBrief: this.store.record<Brief>(job.id, "brief", "brief"),
							previousCoverage: this.store
								.research(job.id)
								.rounds.filter((x) => x.evaluation)
								.at(-1)?.evaluation?.coverage,
							knownClaims: this.store
								.all<Claim>(job.id, "claim")
								.filter((c) => c.accepted)
								.map((c) => ({ id: c.id, text: c.text })),
							retrievalHistory: this.store
								.workItems(job.id)
								.filter((x) => x.kind === "fetch")
								.map((x) => ({
									url: x.payload.url,
									status: x.status,
									error: x.error,
								})),
							questions: r.queries,
							purpose: r.purpose,
							candidates: pool,
							maxSelected: Math.min(
								4,
								job.budget.documents - job.usage.documents,
							),
						})
					: { text: '{"decisions":[]}' };
				const selection = selectionSchema.parse(JSON.parse(result.text));
				exactIds(
					pool.map((c) => c.id),
					selection.decisions.map((d) => d.id),
				);
				if (batched && !w.payload.finalPass) {
					this.store.commit(
						t,
						() => {
							w.payload.shortlist = [
								...shortlist,
								...selection.decisions
									.filter((d) => d.selected)
									.map((d) => d.id),
							];
							w.payload.offset = offset + 8;
							w.payload.finalPass = offset + 8 >= r.candidates.length;
							w.payload.pass = Number(w.payload.pass ?? 0) + 1;
							w.payload.repair = 0;
							w.status = "pending";
							this.store.saveWork(w);
							this.store.event(job.id, "sources.preselected", {
								round: r.id,
								offset,
								decisions: selection.decisions,
							});
						},
						{ phase: "round" },
					);
					return;
				}
				const selected = selection.decisions
					.filter((d) => d.selected)
					.sort((a, b) => b.priority - a.priority);
				if (
					selected.length >
					Math.min(4, job.budget.documents - job.usage.documents)
				)
					throw new Error("SELECTION_LIMIT");
				this.complete(t, w, selection, () => {
					r.selected = selected.map((s) => s.id);
					r.state = "reading";
					const reads: string[] = [];
					for (const d of selected) {
						const c = r.candidates.find((c) => c.id === d.id);
						if (!c) throw new Error("SOURCE_MISSING");
						const fetch = this.enqueue(
							job,
							r.id,
							"fetch",
							{
								url: c.url,
								title: c.title,
								candidateId: c.id,
								selectionReason: d.reason,
								questionIds:
									this.store
										.record<Brief>(job.id, "brief", "brief")
										?.requirements.map((q) => q.id) ?? [],
							},
							[],
							d.priority,
						);
						const read = this.enqueue(
							job,
							r.id,
							"read",
							{ fetchId: fetch.id, candidateId: c.id },
							[fetch.id],
							d.priority,
						);
						const validation = this.enqueue(
							job,
							r.id,
							"check_claims",
							{ readId: read.id },
							[read.id],
							d.priority,
						);
						reads.push(validation.id);
					}
					this.enqueue(job, r.id, "evaluate", {}, reads, 0);
					this.saveRound(job, r);
					this.store.event(job.id, "round.sources_selected", {
						round: r.number,
						decisions: selection.decisions,
					});
				});
				return;
			}
			if (w.kind === "fetch") {
				const url = String(w.payload.url);
				const old = this.store
					.all<Snapshot>(job.id, "source")
					.find((s) => s.url === url || s.finalUrl === url);
				let source = old;
				if (!source)
					source = await this.host.operation(
						t,
						`crawl:round:${w.id}:${w.payload.fetchAttempt ?? 0}`,
						{ requests: 1, urls: w.payload.fetchAttempt ? 0 : 1 },
						() => this.providers.crawler.crawl(url, signal),
					);
				const saved = source;
				this.complete(t, w, { sourceId: saved.id }, () => {
					this.store.put(job.id, "source", saved.id, saved);
					this.store.event(job.id, "source.saved", {
						id: saved.id,
						title: saved.title,
						url: saved.finalUrl,
						questionIds: w.payload.questionIds,
						selectionReason: w.payload.selectionReason,
					});
				});
				return;
			}
			if (w.kind === "read" && r) {
				const fetch = this.store
					.workItems(job.id)
					.find((i) => i.id === w.payload.fetchId);
				const sid =
					typeof w.payload.sourceId === "string"
						? w.payload.sourceId
						: (fetch?.result as { sourceId?: string })?.sourceId;
				if (!sid) {
					this.complete(t, w, {
						unread: true,
						reason: fetch?.error ?? "FETCH_FAILED",
					});
					return;
				}
				const source = this.store.record<Snapshot>(job.id, "source", sid);
				if (!source) throw new Error("SOURCE_MISSING");
				if (
					job.config.researchControlVersion === 2 &&
					typeof w.payload.start !== "number"
				) {
					const readRanges = this.store
						.workItems(job.id)
						.filter(
							(i) =>
								i.kind === "read" &&
								i.status === "succeeded" &&
								(i.result as { sourceId?: string })?.sourceId === source.id,
						)
						.flatMap((i) =>
							(
								(i.result as { passages?: { start: number; length: number }[] })
									.passages ?? []
							).map((p) => ({ start: p.start, end: p.start + p.length })),
						);
					if (readRanges.length >= Number(job.config.sourceRangeLimit ?? 8)) {
						this.complete(t, w, {
							unread: true,
							reason: "SOURCE_RANGE_BUDGET",
							sourceId: source.id,
							readRanges,
						});
						return;
					}
					const selected = rangeSelectionSchema.parse(
						JSON.parse(
							(
								await this.llm(t, w, job, "source_range_select", {
									originalRequest: job.topic,
									questions: this.store.all(job.id, "question"),
									index: sourceIndex(source),
									readRanges,
									maxRangeBytes: Number(job.config.sourceRangeBytes ?? 12000),
								})
							).text,
						),
					);
					if (selected.done) {
						this.complete(t, w, {
							unread: true,
							reason: selected.reason,
							sourceId: source.id,
							readRanges,
						});
						return;
					}
					readSourceRange(
						source,
						source.hash,
						selected,
						Number(job.config.sourceRangeBytes ?? 12000),
						readRanges,
					);
					this.store.commit(
						t,
						() => {
							w.payload.start = selected.start;
							w.payload.end = selected.end;
							w.payload.sourceId = source.id;
							w.payload.rangeReason = selected.reason;
							w.payload.pass = Number(w.payload.pass ?? 0) + 1;
							w.status = "pending";
							this.store.saveWork(w);
						},
						{ phase: "round" },
					);
					return;
				}
				const passages =
					typeof w.payload.start === "number" &&
					typeof w.payload.end === "number"
						? [
								readSourceRange(
									source,
									source.hash,
									{ start: w.payload.start, end: w.payload.end },
									Number(job.config.sourceRangeBytes ?? 12000),
								),
							]
						: selectSections(
								source.text,
								`${job.topic} ${r.queries.join(" ")}`,
								6000,
							);
				if (!passages.length) {
					this.complete(t, w, { unread: true, reason: "NO_RELEVANT_PASSAGES" });
					return;
				}
				const existing = this.store
					.all<Claim>(job.id, "claim")
					.filter((c) => c.accepted);
				const input = {
					topic: job.topic,
					researchBrief: {
						originalRequest: job.topic,
						...this.store.record<Brief>(job.id, "brief", "brief"),
					},
					roundQuestions: r.queries,
					researchPurpose: r.purpose,
					source: {
						title: source.title,
						url: source.finalUrl,
						readingNotice: pdfReadNotice(source.pdf),
					},
					passages,
					existingClaims: existing
						.slice(-12)
						.map((c) => ({ id: c.id, text: c.text })),
				};
				const text = JSON.stringify(input);
				if (
					Buffer.byteLength(
						prompt("extract", text).system +
							prompt("extract", text).content.text,
					) > Number(job.config.providerInputBytes ?? 200000)
				)
					throw Error("PROVIDER_INPUT_LIMIT");
				const result = await this.host.operation(
					t,
					`round:${w.id}:extract:${w.payload.repair ?? 0}`,
					{
						requests: 1,
						documents: w.payload.repair ? 0 : 1,
						...splitTokenReservation(
							tokenReservation(text, "extract") +
								(job.config.llmProvider === "codex" ? 20000 : 0),
							outputLimit("extract"),
						),
					},
					() => this.providers.llm.complete("extract", text, signal),
				);
				const parsed = claimResponse.parse(JSON.parse(result.text));
				const proposed: string[] = [];
				this.complete(
					t,
					w,
					{
						sourceId: sid,
						passages: passages.map((p) => ({
							start: p.start,
							length: p.text.length,
						})),
						concepts: parsed.concepts,
						claimIds: proposed,
					},
					() => {
						for (const entry of parsed.claims) {
							try {
								const location = locateEvidence(source, entry.quote);
								if (
									!passages.some(
										(p) =>
											location.start >= p.start &&
											location.end <= p.start + p.text.length,
									)
								)
									throw new Error("QUOTE_OUTSIDE_SELECTED_PASSAGES");
								const duplicate = existing.find(
									(c) => normalize(c.text) === normalize(entry.text),
								);
								if (duplicate) continue;
								const evidence: Evidence = {
									id: uid(),
									snapshotId: source.id,
									...location,
								};
								const related = existing.find(
									(c) => c.id === entry.relatedClaimId,
								);
								const claim: Claim = {
									id: uid(),
									text: entry.text,
									evidenceIds: [evidence.id],
									confidence: entry.confidence,
									kind:
										entry.relation === "contradicts"
											? "CONTRADICTION"
											: entry.confidence >= 0.6
												? "NEW"
												: "WEAK_EVIDENCE",
									accepted: false,
									reason: `${r.purpose}: 引用の原文一致を確認`,
									relatedClaimIds: related ? [related.id] : [],
								};
								this.store.put(job.id, "evidence", evidence.id, evidence);
								this.store.put(job.id, "claim", claim.id, claim);
								proposed.push(claim.id);
								this.store.put(job.id, "round_claim", claim.id, {
									id: claim.id,
									roundId: r.id,
									purpose: r.purpose,
								});
							} catch (error) {
								this.store.event(job.id, "claim.rejected", {
									reason: String(error),
								});
							}
						}
						this.store.put(job.id, "discovery", w.id, {
							id: w.id,
							roundId: r.id,
							concepts: parsed.concepts,
						});
					},
				);
				return;
			}

			if (w.kind === "check_claims" && r) {
				const read = this.store
					.workItems(job.id)
					.find((i) => i.id === w.payload.readId);
				const ids = (read?.result as { claimIds?: string[] })?.claimIds ?? [];
				const claims = this.store
					.all<Claim>(job.id, "claim")
					.filter((c) => ids.includes(c.id));
				if (!claims.length) {
					this.complete(t, w, { claimIds: [] }, () =>
						this.continueSource(job, r, w, read),
					);
					return;
				}
				const input = {
					originalRequest: job.topic,
					purpose: r.purpose,
					readerBrief: this.store.record<Brief>(job.id, "brief", "brief"),
					previousCoverage: this.store
						.research(job.id)
						.rounds.filter((x) => x.evaluation)
						.at(-1)?.evaluation?.coverage,
					knownClaims: this.store
						.all<Claim>(job.id, "claim")
						.filter((c) => c.accepted)
						.map((c) => ({ id: c.id, text: c.text })),
					retrievalHistory: this.store
						.workItems(job.id)
						.filter((x) => x.kind === "fetch")
						.map((x) => ({
							url: x.payload.url,
							status: x.status,
							error: x.error,
						})),
					questions: r.queries,
					claims: claims.map((c) => ({
						id: c.id,
						text: c.text,
						quotes: this.store
							.all<Evidence>(job.id, "evidence")
							.filter((e) => c.evidenceIds.includes(e.id))
							.map((e) => e.quote),
					})),
				};
				const result = await this.llm(t, w, job, "check_claims", input);
				const checked = selectionSchema.parse(JSON.parse(result.text));
				exactIds(
					ids,
					checked.decisions.map((d) => d.id),
				);
				this.complete(t, w, checked, () => {
					this.continueSource(job, r, w, read);

					for (const d of checked.decisions) {
						const c = claims.find((c) => c.id === d.id);
						if (!c) throw new Error("CLAIM_MISSING");
						c.accepted =
							d.selected &&
							c.confidence >= 0.6 &&
							(c.kind !== "CONTRADICTION" || c.relatedClaimIds.length > 0);
						c.reason = d.reason;
						this.store.put(job.id, "claim", c.id, c);
					}
				});
				return;
			}

			if (w.kind === "compress_claims") {
				const ids = w.payload.claimIds as string[];
				const claims = this.store
					.all<Claim>(job.id, "claim")
					.filter((c) => ids.includes(c.id));
				const result = await this.llm(t, w, job, "compress_claims", {
					originalRequest: job.topic,
					claims,
				});
				const parsed = summariesSchema.parse(JSON.parse(result.text));
				exactIds(
					ids,
					parsed.summaries.map((c) => c.id),
				);
				this.complete(t, w, parsed, () => {
					for (const summary of parsed.summaries)
						this.store.put(job.id, "claim_summary", summary.id, summary);
				});
				return;
			}
			if (w.kind === "evaluate" && r) {
				const memory = await this.checkpoint(t, w, job);
				if (job.config.memoryVersion === 1 && !memory) return;
				if (job.config.researchControlVersion === 2 && memory) {
					await this.direction(t, w, job, r, memory);
					return;
				}
				this.store.atomic(() => {
					this.store.assertLease(t);
					r.state = "evaluating";
					this.saveRound(job, r);
				});
				const brief = this.store.record<Brief>(job.id, "brief", "brief");
				if (!brief) throw new Error("BRIEF_MISSING");
				const current = this.store.research(job.id);
				const revision = current.revision;
				if (w.payload.evaluation && w.payload.evaluationRevision !== revision) {
					delete w.payload.evaluation;
					w.payload.pass = Number(w.payload.pass ?? 0) + 1;
				}
				if (w.payload.replanned)
					this.store.atomic(() => {
						this.store.assertLease(t);
						this.meta(job, { decisionLocked: true });
					});
				const claims = this.store
					.all<Claim>(job.id, "claim")
					.filter((c) => c.accepted);
				let input = {
					memory,
					originalRequest: job.topic,
					brief,
					claims: claims.map((c) => ({
						id: c.id,
						text: c.text,
						evidence: this.store
							.all<Evidence>(job.id, "evidence")
							.filter((e) => c.evidenceIds.includes(e.id))
							.map((e) => ({ quote: e.quote, sourceId: e.snapshotId })),
					})),
					round: r.number,
					omitted: false,
					discoveries: this.store.all(job.id, "discovery"),
					userCandidates: current.candidates.filter(
						(c) => c.status === "pending",
					),
					previousQueries: this.store
						.all<Query>(job.id, "query")
						.map((q) => q.query),
					failures: this.store
						.workItems(job.id)
						.filter(
							(i) => i.error || (i.result as { unread?: boolean })?.unread,
						),
					previousEvaluations: current.rounds
						.filter((x) => x.evaluation)
						.map((x) => ({
							round: x.number,
							coverage: x.evaluation?.coverage,
							reason: x.evaluation?.reason,
						})),
					remainingRounds: job.budget.rounds - r.number,
				};
				const maxBytes = Number(job.config.evaluationContextBytes ?? 48000);
				if (new TextEncoder().encode(JSON.stringify(input)).length > maxBytes) {
					const summaries = this.store.all<{
						id: string;
						text: string;
						qualifications: string;
					}>(job.id, "claim_summary");
					const missing = claims.filter(
						(c) => !summaries.some((s) => s.id === c.id),
					);
					if (missing.length) {
						this.store.commit(
							t,
							() => {
								for (let i = 0; i < missing.length; i += 8) {
									const compressed = this.enqueue(
										job,
										r.id,
										"compress_claims",
										{ claimIds: missing.slice(i, i + 8).map((c) => c.id) },
										[],
										10,
									);
									w.dependsOn.push(compressed.id);
								}
								w.status = "pending";
								this.store.saveWork(w);
							},
							{ phase: "round" },
						);
						return;
					}
					input = {
						...input,
						claims: claims.map((c) => {
							const summary = summaries.find((s) => s.id === c.id);
							return {
								id: c.id,
								text: `${summary?.text} ${summary?.qualifications}`,
								evidence: [],
								verifiedEvidenceIds: c.evidenceIds,
							};
						}),
					};
					if (new TextEncoder().encode(JSON.stringify(input)).length > maxBytes)
						throw new Error("EVALUATION_CONTEXT_LIMIT");
				}
				let evaluation: Evaluation;
				if (w.payload.evaluation) {
					evaluation = validateEvaluation(
						w.payload.evaluation,
						brief,
						claims.map((c) => c.id),
					);
					const audit = await this.llm(t, w, job, "review_opportunities", {
						originalRequest: job.topic,
						readerBrief: brief,
						knownClaims: input.claims,
						previousQueries: input.previousQueries,
						previousEvaluations: input.previousEvaluations,
						coverage: evaluation.coverage,
						sufficient: evaluation.sufficient,
						opportunities: evaluation.opportunities,
					});
					const decisions = selectionSchema.parse(
						JSON.parse(audit.text),
					).decisions;
					exactIds(
						evaluation.opportunities.map((o) => o.id),
						decisions.map((d) => d.id),
					);
					evaluation = {
						...evaluation,
						opportunities: evaluation.opportunities.flatMap((o) => {
							const d = decisions.find((d) => d.id === o.id)!;
							return d.selected
								? [{ ...o, priority: d.priority, reason: d.reason }]
								: [];
						}),
					};
					this.store.assertLease(t);
					this.store.event(job.id, "round.opportunities_reviewed", {
						round: r.number,
						decisions,
					});
				} else {
					const result = await this.llm(t, w, job, "evaluate_round", input);
					evaluation = validateEvaluation(
						JSON.parse(result.text),
						brief,
						claims.map((c) => c.id),
					);
					if (evaluation.opportunities.length && r.number < job.budget.rounds) {
						this.store.commit(
							t,
							() => {
								w.payload.evaluation = evaluation;
								w.payload.evaluationRevision = revision;
								w.status = "pending";
								this.store.saveWork(w);
								this.store.event(job.id, "round.reviewed", {
									round: r.number,
									evaluation,
								});
							},
							{ phase: "round" },
						);
						return;
					}
				}
				if (
					memory &&
					!memoryReviewPass(memory) &&
					job.config.researchControlVersion !== 2
				) {
					evaluation.sufficient = false;
					evaluation.reason += " / Memory reuse review unresolved";
					const researchGaps =
						memory.review?.defects.filter((d) => d.route === "research") ?? [];
					evaluation.opportunities = evaluation.opportunities.filter((o) =>
						researchGaps.some(
							(d) =>
								d.requirementId === o.requirementId ||
								d.requirementId === "general",
						),
					);
				}
				this.store.assertLease(t);
				if (
					this.store.research(job.id).revision !== revision &&
					!w.payload.replanned
				) {
					this.store.commit(
						t,
						() => {
							w.payload.replanned = true;
							w.payload.repair = Number(w.payload.repair ?? 0) + 1;
							w.status = "pending";
							this.store.saveWork(w);
						},
						{ phase: "round" },
					);
					return;
				}
				this.complete(t, w, evaluation, () => {
					if (this.store.research(job.id).revision !== revision)
						throw new Error("RESEARCH_REVISION_CHANGED");
					this.meta(job, { decisionLocked: false });
					r.state = "evaluated";
					r.evaluation = evaluation;
					this.saveRound(job, r);
					this.meta(job, {
						sufficient: evaluation.sufficient,
						reason: evaluation.reason,
					});
					const fresh = this.store.getJob(job.id) as Job;
					const hold = this.finishHold(fresh);
					const canAfford =
						fresh.usage.tokens + hold.tokens + 16000 < fresh.budget.tokens &&
						fresh.usage.requests + hold.requests + 7 < fresh.budget.requests &&
						fresh.usage.documents < fresh.budget.documents &&
						fresh.usage.queries < fresh.budget.queries &&
						r.number <= fresh.budget.depth;
					const next = chooseOpportunities(
						evaluation,
						input.previousQueries,
						job.budget.rounds - r.number,
						canAfford,
					);
					this.store.event(job.id, "round.evaluated", {
						round: r.number,
						evaluation,
						next: next.map((o) => o.query),
					});
					for (const c of input.userCandidates)
						this.store.put(job.id, "exploration_candidate", c.id, {
							...c,
							status: "evaluated",
						});
					next.splice(Math.max(0, fresh.budget.queries - fresh.usage.queries));
					if (next.length)
						this.startRound(
							fresh,
							next.map((o) => o.query),
							next[0].purpose,
							next.map((o) => o.reason).join("; "),
						);
					else
						this.finalize(
							fresh,
							canAfford
								? r.number >= job.budget.rounds
									? "round_budget"
									: "no_valuable_candidate"
								: "budget_exhausted",
						);
				});
				return;
			}
			if (w.kind === "synthesize" || w.kind === "edit") {
				let memory: MemoryBundle | null = null;
				if (w.kind === "edit")
					memory =
						this.store
							.detail(job.id)
							?.memory?.find(
								(m) =>
									m.id === (w.payload.previousReport as Artifact)?.memoryId,
							) ?? null;
				if (!memory) memory = await this.checkpoint(t, w, job);
				if (job.config.memoryVersion === 1 && !memory) return;
				const detail = this.store.detail(job.id);
				if (!detail) throw new Error("JOB_MISSING");
				const claims = detail.claims.filter((c) => c.accepted);
				if (!claims.length) {
					this.fallback(t, job, job.reason || "no_verified_claims");
					return;
				}
				const input = {
					...researchInput(detail),
					memory,
					readerBrief: this.store.record<Brief>(job.id, "brief", "brief"),
					roundEvaluations: detail.research?.rounds.map((r) => r.evaluation),
					supplementClaims: this.store.all(job.id, "round_claim"),
					previousReport: w.payload.previousReport,
					feedback: w.payload.feedback,
				};
				const response = await this.llm(
					t,
					w,
					job,
					w.kind === "edit" ? "edit" : "synthesize",
					input,
				);
				const parsed = reportResponse.parse(JSON.parse(response.text));
				const ids = [
					...new Set(
						parsed.sections
							? parsed.sections.flatMap((s) =>
									s.paragraphs.flatMap((p) => p.claimIds),
								)
							: parsed.claimIds,
					),
				];
				validateClaims(detail, ids);
				const artifact: Artifact = {
					memoryId: memory?.id,
					id: `round-report-${job.id}-${(detail.artifacts[0]?.version ?? 0) + 1}`,
					version: (detail.artifacts[0]?.version ?? 0) + 1,
					title: job.topic,
					body: parsed.sections
						? parsed.sections
								.map(
									(s) =>
										`${s.title}\n\n${s.paragraphs.map((p) => p.text).join("\n\n")}`,
								)
								.join("\n\n")
						: reportBody(
								claims.filter((c) => ids.includes(c.id)),
								job.mode === "mock",
							),
					sections: parsed.sections,
					claimIds: ids,
					limitations: parsed.limitations,
					openQuestions: parsed.openQuestions,
					generatedAt: new Date().toISOString(),
					fixture: job.mode === "mock",
				};
				this.complete(t, w, artifact, () =>
					this.enqueue(job, "final", "review", {
						artifact,
						edited: w.kind === "edit",
						baseArtifactId: detail.artifacts[0]?.id ?? null,
					}),
				);
				return;
			}
			if (w.kind === "review") {
				const artifact = w.payload.artifact as unknown as Artifact;
				const detail = this.store.detail(job.id);
				if (!detail) throw new Error("JOB_MISSING");
				if (job.mode === "mock") {
					this.publish(t, job, artifact);
					return;
				}
				const result = await this.llm(t, w, job, "review", {
					...researchInput(detail),
					readerBrief: this.store.record<Brief>(job.id, "brief", "brief"),
					report: artifact,
				});
				const review = reviewSchema.parse(JSON.parse(result.text));
				const structural = assessStructure(detail, artifact);
				const passed =
					job.config.memoryVersion === 1
						? structural.pass &&
							review.scores.support >= 4 &&
							review.majorIssues.length === 0
						: reviewPass(structural.pass, review);
				if (
					job.config.researchControlVersion === 2 &&
					review.researchNeeded &&
					!w.payload.reviewOnly &&
					this.store.all<Round>(job.id, "round").length < job.budget.rounds &&
					fits(
						this.store.getJob(job.id)!,
						{
							tokens: evaluationHold(job).tokens + 20000,
							requests: evaluationHold(job).requests + 3,
						},
						[this.finishHold(job)],
					)
				) {
					this.complete(t, w, review, () => {
						this.store.put(job.id, "artifact", artifact.id, {
							...artifact,
							qualityState: "needs_revision",
						});
						exportArtifact(detail, artifact, this.root);
						const revision = this.store.research(job.id).revision + 1;
						this.meta(job, { revision, sufficient: false });
						const current = this.store.getJob(job.id)!;
						current.status = "running";
						this.store.saveJob(current);
						const last = this.store.all<Round>(job.id, "round").at(-1)!;
						this.enqueue(
							job,
							last.id,
							"evaluate",
							{ reportDefects: review.majorIssues, researchRevision: revision },
							[],
							0,
						);
						this.store.event(job.id, "report.research_reopened", {
							artifactId: artifact.id,
							revision,
							reasons: review.majorIssues,
						});
					});
					return;
				}
				if (!passed && !w.payload.edited && !w.payload.reviewOnly) {
					this.complete(t, w, review, () =>
						this.enqueue(job, "final", "edit", {
							previousReport: artifact,
							feedback: review,
						}),
					);
					return;
				}
				artifact.qualityState = passed ? "reviewed" : "needs_revision";
				this.publish(t, job, artifact, {
					id: `v${artifact.version}`,
					version: artifact.version,
					rubricVersion: REVIEW_VERSION,
					review,
					structural,
					score: reviewScore(review),
				});
				return;
			}
			throw new Error(`UNKNOWN_WORK_KIND:${w.kind}`);
		} catch (error) {
			if (error instanceof LeaseLost) throw error;
			if (
				error instanceof Error &&
				error.message === "RESEARCH_REVISION_CHANGED"
			) {
				this.store.commit(
					t,
					() => {
						w.payload.replanned = true;
						w.payload.pass = Number(w.payload.pass ?? 0) + 1;
						w.status = "pending";
						this.store.saveWork(w);
					},
					{ phase: "round" },
				);
				return;
			}
			if (
				signal.aborted ||
				this.store.getJob(job.id)?.status === "cancel_requested"
			) {
				this.store.commit(
					t,
					() => {
						const current = this.store.getJob(job.id) as Job;
						current.status =
							current.status === "cancel_requested" ? "cancelled" : "partial";
						current.reason = "interrupted";
						this.store.saveJob(current);
						w.status = "pending";
						this.store.saveWork(w);
					},
					{ phase: "round" },
					true,
				);
				return;
			}
			if (
				w.kind === "fetch" &&
				error instanceof LlmFetchError &&
				error.retryable &&
				Number(w.payload.fetchAttempt ?? 0) < 2
			) {
				this.store.commit(
					t,
					() => {
						w.payload.fetchAttempt = Number(w.payload.fetchAttempt ?? 0) + 1;
						w.status = "pending";
						w.nextAt = Date.now() + 1000 * 2 ** Number(w.payload.fetchAttempt);
						this.store.saveWork(w);
						this.store.event(job.id, "source.retry", {
							id: w.id,
							reason: error.message,
						});
					},
					{ phase: "round" },
					false,
					250,
				);
				return;
			}
			if (
				w.kind === "search_poll" &&
				error instanceof SearchProviderError &&
				error.retryable &&
				Number(w.payload.poll) < 29
			) {
				const submission = this.store
					.workItems(job.id)
					.find((i) => i.id === w.payload.submitId)?.result as
					| { id?: string }
					| undefined;
				if (submission?.id)
					this.store.markExternal(t, `pending:${submission.id}`);
				this.store.commit(
					t,
					() => {
						w.payload.poll = Number(w.payload.poll) + 1;
						w.status = "pending";
						w.nextAt = Date.now() + 1000;
						this.store.saveWork(w);
					},
					{ phase: "round" },
					false,
					250,
				);
				return;
			}
			if (error instanceof BudgetExceeded) {
				if (["synthesize", "review", "edit"].includes(w.kind)) {
					this.fallback(t, job, "generation_budget_exhausted");
					return;
				}
				this.store.commit(
					t,
					() => {
						w.status = "skipped";
						w.error = "budget_exhausted";
						this.store.saveWork(w);
						if (r) {
							r.state = "interrupted";
							this.saveRound(job, r);
						}
						for (const item of this.store
							.workItems(job.id)
							.filter(
								(i) =>
									i.roundId !== "final" &&
									(i.status === "pending" || i.status === "running"),
							)) {
							item.status = "skipped";
							item.error = "budget_exhausted";
							this.store.saveWork(item);
						}
						this.finalize(job, "budget_exhausted");
					},
					{ phase: "round" },
				);
				return;
			}
			if (
				this.store.slot().state === "blocked" ||
				String(error).includes("EXTERNAL_RESULT_UNKNOWN")
			) {
				this.store.commit(
					t,
					() => {
						if (r) {
							r.state = "blocked";
							this.saveRound(job, r);
						}
						job = this.store.getJob(job.id) as Job;
						job.status = "partial";
						job.reason = "external_result_unknown";
						if (w.payload.actionId) {
							const action = this.store.record<Record<string, unknown>>(
								job.id,
								"action",
								String(w.payload.actionId),
							);
							if (action)
								this.store.put(job.id, "action", String(w.payload.actionId), {
									...action,
									status: "unknown",
									lastWorkId: w.id,
								});
						}
						this.store.saveJob(job);
					},
					{ phase: "round" },
					true,
				);
				return;
			}
			if (
				[
					"prepare_brief",
					"compress_claims",
					"check_claims",
					"select_sources",
					"evaluate",
					"read",
					"synthesize",
					"review",
					"edit",
				].includes(w.kind) &&
				!w.payload.repair
			) {
				this.store.commit(
					t,
					() => {
						w.payload.repair = 1;
						w.payload.validationError = String(error);
						w.status = "pending";
						this.store.saveWork(w);
						this.store.event(job.id, "work.invalid_response", {
							id: w.id,
							reason: String(error),
						});
					},
					{ phase: "round" },
				);
				return;
			}
			if (
				w.kind === "fetch" ||
				w.kind === "read" ||
				w.kind === "check_claims"
			) {
				const failure = {
					unread: true,
					reason: String(error),
					...(error instanceof LlmFetchError
						? {
								code: error.code,
								guardDecision: error.guardDecision,
								warningCategories: error.warningCategories,
							}
						: {}),
				};
				this.complete(t, w, failure, () => {
					w.error = String(error);
					w.status = w.kind === "fetch" ? "failed" : "skipped";
					this.store.saveWork(w);
					this.store.event(job.id, "source.skipped", {
						id: w.id,
						url: w.payload.url,
						questionIds: w.payload.questionIds,
						selectionReason: w.payload.selectionReason,
						...failure,
					});
				});
				return;
			}
			this.fallback(t, job, String(error));
		}
	}
	publish(t: Task, job: Job, artifact: Artifact, review?: unknown) {
		this.store.commit(
			t,
			() => {
				const d = this.store.detail(job.id);
				if (!d) throw new Error("JOB_MISSING");
				const active = this.store
					.workItems(job.id)
					.find((w) => w.status === "running");
				if (
					active &&
					"baseArtifactId" in active.payload &&
					(d.artifacts[0]?.id ?? null) !== active.payload.baseArtifactId
				)
					throw new Error("ARTIFACT_CHANGED_DURING_GENERATION");
				this.store.put(job.id, "outcome", artifact.id, {
					id: artifact.id,
					memoryId: artifact.memoryId ?? null,
					artifactId: artifact.id,
					research: this.store.research(job.id).sufficient
						? "satisfied"
						: "unmet",
					memoryInspection:
						d.memory?.find((m) => m.id === artifact.memoryId)?.status ??
						"not_run",
					reuseTest: "not_run",
					reportInspection: artifact.qualityState ?? "not_run",
					stopReason: job.reason,
				});
				exportArtifact(d, artifact, this.root);
				this.store.put(job.id, "artifact", artifact.id, artifact);
				for (const round of d.research?.rounds ?? []) {
					const claimIds = this.store
						.all<{ id: string; roundId: string }>(job.id, "round_claim")
						.filter((c) => c.roundId === round.id)
						.map((c) => c.id);
					const used = claimIds.filter((id) => artifact.claimIds.includes(id));
					this.store.put(job.id, "exploration_outcome", round.id, {
						id: round.id,
						purpose: round.purpose,
						queries: round.queries,
						usedClaimIds: used,
						paragraphs:
							artifact.sections?.flatMap((section, si) =>
								section.paragraphs.flatMap((p, pi) =>
									p.claimIds.some((id) => used.includes(id))
										? [`${si + 1}.${pi + 1}`]
										: [],
								),
							) ?? [],
						reason: used.length
							? "採用した根拠を本文に反映"
							: "追加根拠を本文へ採用しなかった",
					});
				}
				for (const candidate of job.config.memoryVersion === 1
					? d.memory?.find((m) => m.id === artifact.memoryId)
						? memoryCandidates(
								d.memory.find((m) => m.id === artifact.memoryId)!,
								artifact,
							)
						: []
					: reportCandidates(d, artifact))
					if (!this.store.record(job.id, "candidate", candidate.id))
						this.store.put(job.id, "candidate", candidate.id, candidate);
				if (review)
					this.store.put(
						job.id,
						"quality_review",
						`v${artifact.version}`,
						review,
					);
				for (const hold of this.store.all<{ id: string; state: string }>(
					job.id,
					"budget_hold",
				))
					this.store.put(job.id, "budget_hold", hold.id, {
						...hold,
						state: "released",
					});
				const fresh = this.store.getJob(job.id) as Job;
				fresh.status =
					d.research?.sufficient === true &&
					artifact.qualityState !== "needs_revision" &&
					(job.config.memoryVersion !== 1 ||
						!!d.memory?.some(
							(m) => m.id === artifact.memoryId && memoryReviewPass(m),
						))
						? "completed"
						: "partial";
				const maintenance = fresh.config.maintenance as
					| { previousStatus?: Job["status"] }
					| undefined;
				if (
					maintenance &&
					artifact.qualityState !== "needs_revision" &&
					(job.config.memoryVersion !== 1 ||
						!!d.memory?.some(
							(m) => m.id === artifact.memoryId && memoryReviewPass(m),
						))
				)
					fresh.status = maintenance.previousStatus ?? fresh.status;
				delete fresh.config.maintenance;
				if (artifact.qualityState === "needs_revision")
					this.meta(job, { sufficient: false, decisionLocked: false });
				fresh.reason ??= "no_valuable_candidate";
				this.store.saveJob(fresh);
				for (const w of this.store
					.workItems(job.id)
					.filter((w) => w.status === "running")) {
					w.status = "succeeded";
					this.store.saveWork(w);
				}
				this.store.event(job.id, `job.${fresh.status}`, {
					artifactId: artifact.id,
				});
			},
			{ phase: "round" },
			true,
		);
	}
	fallback(t: Task, job: Job, reason: string) {
		const d = this.store.detail(job.id);
		if (!d) throw new Error("JOB_MISSING");
		const claims = d.claims.filter((c) => c.accepted);
		let retained = d.memory?.[0];
		if (job.config.memoryVersion === 1 && !retained) {
			retained = emptyBundle(this.memoryDetail(job));
			const recorded = retained.events.filter(
				(e) => e.type === "source.skipped" || e.type === "job.started",
			);
			if (recorded.length)
				retained.episodes = [
					{
						id: "ep:unmet",
						title: job.topic,
						context: "調査の停止時点",
						intent: job.topic,
						observations: reason,
						decisions: [],
						actionTaken: "保存済みイベントを参照",
						outcome: "調査は未達。後続利用は未実施。",
						outcomeKind: "unknown",
						failedApproach: [],
						lesson: "停止理由と原文の有無を確認する必要がある",
						triggers: [job.topic],
						openLoops: [reason],
						eventIds: recorded.slice(-60).map((e) => e.id),
						claimIds: [],
					},
				];
			this.store.atomic(() => {
				this.store.assertLease(t);
				this.store.put(job.id, "memory", retained!.id, retained);
			});
		}
		const a: Artifact = {
			memoryId: retained?.id,
			id: `round-report-${job.id}-${(d.artifacts[0]?.version ?? 0) + 1}`,
			version: (d.artifacts[0]?.version ?? 0) + 1,
			title: job.topic,
			body: claims.length
				? reportBody(claims, job.mode === "mock")
				: "十分な根拠を取得できませんでした。",
			claimIds: claims.map((c) => c.id),
			evidenceUnavailable: claims.length === 0,
			limitations: [reason],
			generatedAt: new Date().toISOString(),
			fixture: job.mode === "mock",
			qualityState: "needs_revision",
		};
		this.store.atomic(() => {
			this.store.assertLease(t);
			this.meta(job, { reason, decisionLocked: false });
			const j = this.store.getJob(job.id) as Job;
			j.reason = reason;
			this.store.saveJob(j);
		});
		this.publish(t, job, a);
	}
}
