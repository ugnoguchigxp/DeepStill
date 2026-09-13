import { splitTokenReservation } from "../../packages/research/budget";
import { pdfReadNotice } from "../../packages/core/pdf";
import { DeliverableEngine } from "./deliverable-engine";
import {
	finalHold,
	evaluationHold,
	fits,
} from "../../packages/research/budget";
import { LlmFetchError } from "llm-fetch";
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
	type Hit,
	type Job,
	type Query,
	reportResponse,
	type Snapshot,
	type Usage,
} from "../../packages/contracts";
import {
	bestQuery,
	canonicalUrl,
	locateEvidence,
	normalize,
	scoreQuery,
	selectSections,
	terminal,
} from "../../packages/core";
import { type Crawler, fixtureCrawler } from "../../packages/crawler";
import {
	BudgetExceeded,
	LeaseLost,
	type Store,
	type Task,
	uid,
} from "../../packages/db";
import {
	emptyKnowledge,
	type KnowledgeProvider,
} from "../../packages/integrations/contextstill";
import {
	fixtureLlm,
	type LlmProvider,
	tokenReservation,
} from "../../packages/llm-provider";
import {
	parseScope,
	researchBrief,
	type ScopeItem,
} from "../../packages/research/scope";
import {
	fixtureSearch,
	type SearchProvider,
	SearchProviderError,
} from "../../packages/search-provider";
import { RoundEngine } from "./round-engine";
export interface Providers {
	search: SearchProvider;
	crawler: Crawler;
	llm: LlmProvider;
	knowledge: KnowledgeProvider;
}
export const mocks: Providers = {
	search: fixtureSearch,
	crawler: fixtureCrawler,
	llm: fixtureLlm,
	knowledge: emptyKnowledge,
};
interface State {
	phase:
		| "seed"
		| "suggest"
		| "choose"
		| "submit"
		| "poll"
		| "crawl"
		| "extract"
		| "finalize";
	round: number;
	lowGain: number;
	queryId?: string;
	searchId?: string;
	hits?: Hit[];
	index?: number;
	sourceId?: string;
	poll?: number;
	before?: number;
	successes?: number;
	crawlAttempt?: number;
}
interface Generation {
	id: string;
	input: string;
	baseArtifactId: string | null;
	artifact?: Artifact;
}
interface Operation {
	id: string;
	state: "intent" | "done" | "unknown";
	token: string;
	result?: unknown;
	error?: string;
	reserved: Partial<Usage>;
}
export class Engine {
	constructor(
		readonly store: Store,
		private providers: (job: Job) => Providers = () => mocks,
		private exportRoot = "data/artifacts",
	) {}
	async operation<T>(
		t: Task,
		id: string,
		amount: Partial<Usage>,
		fn: () => Promise<T>,
	): Promise<T> {
		const old = this.store.record<Operation>(t.job_id, "operation", id);
		if (old?.state === "done") return old.result as T;
		if (old) throw new Error("EXTERNAL_RESULT_UNKNOWN");
		const current = this.store.getJob(t.job_id) as Job;
		if (amount.tokens !== undefined) {
			amount = {
				...amount,
				inputTokens: amount.inputTokens ?? amount.tokens,
				outputTokens: amount.outputTokens ?? amount.tokens,
			};
		}
		if (
			current.config.engineVersion !== 2 &&
			!id.startsWith("synthesis:") &&
			this.newCount(t.job_id) > 0
		) {
			const hold = this.synthesisReserve(current);
			if (
				current.usage.tokens + (amount.tokens ?? 0) + hold >
					current.budget.tokens ||
				current.usage.requests +
					(amount.requests ?? 0) +
					(current.mode === "live" ? 3 : 1) >
					current.budget.requests
			)
				throw new BudgetExceeded();
		}
		this.store.atomic(() => {
			if (
				current.config.engineVersion === 2 &&
				current.config.researchFlow !== "deliverables-v1"
			) {
				const finalStage =
					id.includes(":memory-final:") ||
					["synthesize", "edit", "review"].some((k) => id.includes(`:${k}:`));
				const evaluating =
					id.includes(":evaluate_round:") ||
					id.includes(":research_direction_review:") ||
					id.includes(":research_action_select:") ||
					id.includes(":review_opportunities:") ||
					id.includes(":memory_");
				const holds = [finalHold(current), evaluationHold(current)];
				if (finalStage) for (const h of holds) h.state = "released";
				else if (evaluating) holds[1].state = "released";
				for (const hold of holds)
					this.store.put(current.id, "budget_hold", hold.id, hold);
				if (!fits(current, amount, holds)) throw new BudgetExceeded();
			}
			this.store.reserve(t, amount);
			if (current.config.engineVersion === 2)
				this.store.put(t.job_id, "reservation", id, {
					id,
					state: "reserved",
					amount,
				});
			this.store.put(t.job_id, "operation", id, {
				id,
				state: "intent",
				startedAt: Date.now(),
				token: t.token,
				reserved: amount,
			});
		});
		try {
			const slotOwned = this.store.slot().owner_token === t.token;
			if (slotOwned) this.store.markExternal(t, id);
			const result = await fn();
			if (slotOwned && !this.store.getJob(t.job_id)) {
				this.store.sql
					.query(
						"UPDATE execution_slot SET state='idle',owner_token='',lease_until=0,operation_key=NULL,job_id=NULL WHERE owner_token=?",
					)
					.run(t.token);
				throw new LeaseLost();
			}
			this.store.atomic(() => {
				this.store.assertLease(t);
				if (slotOwned) {
					const work = this.store
						.workItems(t.job_id)
						.find((w) => id === `round:${w.id}`);
					const searchId = (result as { id?: string })?.id;
					this.store.markExternal(
						t,
						work?.kind === "search_submit" && searchId
							? `pending:${searchId}`
							: null,
					);
				}
				this.store.put(t.job_id, "operation", id, {
					id,
					state: "done",
					token: t.token,
					reserved: amount,
					result,
				});
				if (current.config.engineVersion === 2)
					this.store.put(t.job_id, "reservation", id, {
						id,
						state: "settled",
						amount,
						resultUsage: (result as { usage?: number })?.usage ?? null,
						resultTokenUsage:
							(result as { tokenUsage?: unknown })?.tokenUsage ?? null,
						usageEstimated:
							amount.tokens !== undefined &&
							!(result as { tokenUsage?: unknown })?.tokenUsage,
					});
				const value = (result ?? {}) as {
					cost?: number;
					usage?: number | null;
					tokenUsage?: { inputTokens: number; outputTokens: number };
				};
				const j = this.store.getJob(t.job_id);
				if (j) {
					if (
						(value.cost !== undefined &&
							(!Number.isFinite(value.cost) || value.cost < 0)) ||
						(value.usage != null &&
							(!Number.isFinite(value.usage) || value.usage < 0))
					)
						throw new Error("INVALID_PROVIDER_USAGE");
					if (typeof value.cost === "number" && amount.costUsd !== undefined) {
						j.usage.costUsd += value.cost - amount.costUsd;
					}
					if (typeof value.usage === "number" && amount.tokens !== undefined) {
						j.usage.tokens += value.usage - amount.tokens;
					}
					// Missing directional usage retains the reservation, never fabricates a split.
					for (const key of ["inputTokens", "outputTokens"] as const) {
						const actual = value.tokenUsage?.[key];
						if (
							actual !== undefined &&
							(!Number.isSafeInteger(actual) || actual < 0)
						)
							throw new Error("INVALID_PROVIDER_USAGE");
						if (actual !== undefined && amount[key] !== undefined)
							j.usage[key] = (j.usage[key] ?? 0) + actual - amount[key]!;
					}
					this.store.saveJob(j);
					this.store.event(j.id, "operation.completed", {
						id,
						actualCost: value.cost,
						actualTokens: value.usage,
						actualTokenUsage: value.tokenUsage ?? null,
						tokenUsageEstimated:
							amount.tokens !== undefined && !value.tokenUsage,
					});
				}
			});
			return result;
		} catch (error) {
			if (this.store.slot().owner_token === t.token) {
				if (
					error instanceof SearchProviderError ||
					error instanceof LlmFetchError ||
					id.startsWith("crawl:") ||
					(error instanceof Error &&
						error.message.includes("invalid_json_schema"))
				)
					this.store.markExternal(t, null);
				else
					this.store.sql
						.query(
							"UPDATE execution_slot SET state='blocked' WHERE owner_token=?",
						)
						.run(t.token);
			}
			if (!(error instanceof LeaseLost))
				this.store.atomic(() => {
					this.store.assertLease(t);
					this.store.put(t.job_id, "operation", id, {
						id,
						state: "unknown",
						token: t.token,
						reserved: amount,
						error: error instanceof Error ? error.message : "PROVIDER_ERROR",
					});
				});
			throw error;
		}
	}
	addQuery(
		job: Job,
		text: string,
		depth: number,
		parent?: string,
		source = "autocomplete",
		known = "unverified",
	) {
		const query = normalize(text).slice(0, 400);
		if (!query || depth > job.budget.depth) return;
		const list = this.store.all<Query>(job.id, "query");
		let q = list.find((q) => q.query === query);
		if (!q) {
			if (list.length >= job.budget.queries * 10) return;
			q = {
				id: uid(),
				query,
				depth,
				score: scoreQuery(depth, known, job.strategy, list.length),
				reason: `${source}; depth=${depth}; knowledge=${known}`,
				status: known === "known" ? "skipped" : "pending",
				known,
			};
			this.store.put(job.id, "query", q.id, q);
		}
		if (parent && parent !== q.id) {
			const id = `${parent}:${q.id}:${source}`;
			this.store.put(job.id, "edge", id, {
				id,
				from: parent,
				to: q.id,
				source,
			});
		}
		return q;
	}
	finish(
		t: Task,
		state: State,
		status: "partial" | "failed" | "cancelled",
		reason: string,
	) {
		this.store.commit(
			t,
			() => {
				const j = this.store.getJob(t.job_id);
				if (!j) throw new Error("JOB_MISSING");
				j.status = status;
				j.reason = reason;
				this.store.saveJob(j);
				this.store.event(j.id, `job.${status}`, { reason });
			},
			state,
			true,
		);
	}
	async step(t: Task, signal: AbortSignal) {
		const roundJob = this.store.getJob(t.job_id);
		if (
			roundJob?.config.researchFlow === "deliverables-v1" &&
			!roundJob.config.maintenance
		) {
			try {
				return await new DeliverableEngine(
					this,
					this.providers(roundJob),
					this.exportRoot,
				).step(t, signal);
			} catch (error) {
				if (error instanceof LeaseLost) throw error;
				this.finish(t, JSON.parse(t.payload), "failed", this.errorCode(error));
				return;
			}
		}
		if (roundJob?.config.engineVersion === 2 || roundJob?.config.maintenance) {
			try {
				return await new RoundEngine(
					this,
					this.providers(roundJob),
					this.exportRoot,
				).step(t, signal);
			} catch (error) {
				if (error instanceof LeaseLost) throw error;
				this.finish(t, JSON.parse(t.payload), "failed", this.errorCode(error));
				return;
			}
		}
		const loaded = this.store.getJob(t.job_id);
		if (!loaded) throw new Error("JOB_MISSING");
		let job: Job = loaded;
		if (!job.startedAt) {
			this.store.atomic(() => {
				this.store.assertLease(t);
				const current = this.store.getJob(job.id) as Job;
				if (current.status === "queued") {
					current.status = "running";
					current.startedAt = Date.now();
					current.deadline ??= current.startedAt + current.budget.wallMs;
					this.store.saveJob(current);
				}
			});
			job = this.store.getJob(job.id) as Job;
		}
		const state = JSON.parse(t.payload) as State;

		const next = (s: Partial<State>, fn = () => {}, delay = 0) =>
			this.store.commit(t, fn, { ...state, ...s }, false, delay);
		if (terminal(job.status)) {
			this.store.commit(t, () => {}, state, true);
			return;
		}
		if (job.status === "cancel_requested") {
			this.finish(t, state, "cancelled", "user_cancelled");
			return;
		}
		if (job.deadline && Date.now() >= job.deadline) {
			this.finish(t, state, "partial", "time_budget");
			return;
		}
		try {
			const p = this.providers(job);
			if (state.phase === "seed") {
				const knowledge = await p.knowledge.lookup(job.topic, signal);
				next({ phase: "suggest" }, () => {
					const current = this.store.getJob(job.id);
					if (!current) throw new Error("JOB_MISSING");
					if (current.status === "cancel_requested") return;
					current.status = "running";
					current.startedAt ??= Date.now();
					current.deadline ??= current.startedAt + current.budget.wallMs;
					current.config = { ...current.config, knowledge };
					this.store.saveJob(current);
					this.addQuery(
						current,
						current.topic,
						0,
						undefined,
						"seed",
						knowledge.state,
					);
					this.store.event(current.id, "job.started", { knowledge });
				});
				return;
			}
			if (state.phase === "suggest") {
				const r = await this.operation(
					t,
					"suggest",
					{
						requests: 1,
						tokens: job.config.searchProvider === "codex" ? 40000 : 0,
						costUsd: job.mode === "live" ? this.requestCost(job) : 0,
					},
					() => p.search.suggest(job.topic, signal),
				);
				next({ phase: "choose" }, () => {
					const root = this.store.all<Query>(job.id, "query")[0];
					for (const s of r.suggestions.slice(0, 20))
						this.addQuery(job, s, 1, root?.id);
				});
				return;
			}
			if (state.phase === "choose") {
				if (state.lowGain >= 2 && state.round >= 3) {
					next({ phase: "finalize" }, () => this.reason(job.id, "saturated"));
					return;
				}
				const q = bestQuery(this.store.all(job.id, "query"));
				if (!q) {
					next({ phase: "finalize" }, () =>
						this.reason(job.id, "frontier_empty"),
					);
					return;
				}
				if (job.mode === "live") {
					const [decision] = await this.checkScope(
						t,
						job,
						p,
						`query:${q.id}`,
						[{ id: q.id, text: q.query }],
						"query",
						signal,
					);
					if (
						decision.status !== "in_scope" &&
						!(decision.status === "uncertain" && decision.query.trim())
					) {
						next({ phase: "choose" }, () =>
							this.store.put(job.id, "query", q.id, {
								...q,
								status: "skipped",
								reason: decision.reason,
							}),
						);
						return;
					}
					if (!decision.query.trim()) throw new Error("SCOPED_QUERY_REQUIRED");
					q.query = decision.query;
					q.reason = `${decision.status}: ${decision.reason}; question=${decision.question}`;
				}
				const knowledge = await p.knowledge.lookup(q.query, signal);
				next(
					{
						phase: knowledge.state === "known" ? "choose" : "submit",
						queryId: q.id,
						poll: 0,
					},
					() => {
						this.store.put(job.id, "query", q.id, {
							...q,
							known: knowledge.state,
							status: knowledge.state === "known" ? "skipped" : "pending",
							reason: `${q.reason}; ${knowledge.reason}`,
						});
						this.store.event(job.id, "query.selected", {
							query: q.query,
							reason: q.reason,
							id: q.id,
							score: q.score,
							knowledge,
						});
					},
				);
				return;
			}
			const query = this.store.record<Query>(
				job.id,
				"query",
				state.queryId ?? "",
			);
			if (state.phase === "submit") {
				if (!query) throw new Error("QUERY_MISSING");
				const r = await this.operation(
					t,
					`submit:${query.id}`,
					{
						queries: 1,
						requests: 1,
						tokens: 0,
						costUsd: job.mode === "live" ? this.requestCost(job) : 0,
					},
					() => p.search.submit(query.query, signal),
				);
				next({ phase: "poll", searchId: r.id, poll: 0 });
				return;
			}
			if (state.phase === "poll") {
				if (!query || !state.searchId) throw new Error("SEARCH_MISSING");
				const poll = state.poll ?? 0;
				if (poll >= 30) throw new Error("SEARCH_POLL_LIMIT");
				const polledBefore =
					this.store.record<Operation>(
						job.id,
						"operation",
						`poll:${query.id}:${poll}`,
					)?.state === "done";
				const r = await this.operation(
					t,
					`poll:${query.id}:${poll}`,
					{
						requests: 1,
						tokens: job.config.searchProvider === "codex" ? 40000 : 0,
						costUsd: job.mode === "live" ? this.requestCost(job) : 0,
					},
					() =>
						p.search.poll(state.searchId as string, signal, {
							topic: job.topic,
							sources: this.store
								.all<Snapshot>(job.id, "source")
								.map((s) => ({ url: s.finalUrl, title: s.title })),
							failures: this.store
								.all<{ id: string; url: string; reason: string }>(
									job.id,
									"fetch_failure",
								)
								.map(({ url, reason }) => ({ url, reason })),
						}),
				);
				if (!r.ready) {
					next(
						{ poll: poll + 1 },
						() => {},
						Math.min(30000, 1000 * 2 ** Math.min(poll, 5)),
					);
					return;
				}
				if (job.mode === "live" && !polledBefore) {
					next({ phase: "poll" });
					return;
				}
				const urls = new Set(
					this.store
						.all<Snapshot>(job.id, "source")
						.map((s) => canonicalUrl(s.finalUrl)),
				);
				for (const failure of this.store.all<{ url: string }>(
					job.id,
					"fetch_failure",
				))
					urls.add(canonicalUrl(failure.url));
				const hits: Hit[] = [];
				const domains = new Map<string, number>();
				const rankedHits = [...r.hits]
					.sort((a, b) => a.rank - b.rank)
					.slice(0, 12);
				const scope =
					job.mode === "live" && rankedHits.length
						? await this.checkScope(
								t,
								job,
								p,
								`hits:${query.id}`,
								rankedHits.map((h, i) => ({
									id: String(i),
									text: `${h.title}\n${h.snippet}\n${h.url}`,
								})),
								"source",
								signal,
							)
						: null;
				for (const [i, hit] of rankedHits.entries()) {
					// An uncertain source may be fetched to establish eligibility; extraction still must establish scope.
					const decision = scope?.find((d) => d.id === String(i));
					if (decision && !["in_scope", "uncertain"].includes(decision.status))
						continue;
					try {
						const url = canonicalUrl(hit.url),
							host = new URL(url).hostname;
						const n = domains.get(host) ?? 0;
						if (urls.has(url) || n >= (job.strategy === "diverse" ? 1 : 2))
							continue;
						urls.add(url);
						domains.set(host, n + 1);
						hits.push({ ...hit, url });
					} catch {
						/* unsupported search result */
					}
				}
				next(
					{
						phase: "crawl",
						hits: hits.slice(0, 10),
						index: 0,
						before: this.newCount(job.id),
						successes: 0,
					},
					() => {
						this.store.put(job.id, "query", query.id, {
							...query,
							status: "searched",
						});
						this.store.event(job.id, "search.completed", {
							queryId: query.id,
							hits: hits.length,
						});
					},
				);
				return;
			}
			if (state.phase === "crawl") {
				const hit = state.hits?.[state.index ?? 0];
				if (!hit) {
					const gain = this.newCount(job.id) - (state.before ?? 0);
					next(
						{
							phase: "choose",
							round: state.round + 1,
							lowGain:
								(state.successes ?? 0) > 0
									? gain === 0
										? state.lowGain + 1
										: 0
									: 0,
						},
						() =>
							this.store.event(job.id, "round.completed", {
								round: state.round + 1,
								gain,
								successes: state.successes ?? 0,
							}),
					);
					return;
				}
				const existing = this.store
					.all<Snapshot>(job.id, "source")
					.find((s) => s.url === hit.url);
				if (existing) {
					next({ index: (state.index ?? 0) + 1 });
					return;
				}
				try {
					const source = await this.operation(
						t,
						`crawl:${hit.url}:${state.crawlAttempt ?? 0}`,
						{ urls: (state.crawlAttempt ?? 0) === 0 ? 1 : 0, requests: 1 },
						() => p.crawler.crawl(hit.url, signal),
					);
					next(
						{
							phase: "extract",
							crawlAttempt: 0,
							sourceId: source.id,
							successes: (state.successes ?? 0) + 1,
						},
						() => {
							this.store.put(job.id, "source", source.id, source);
							this.store.event(job.id, "source.saved", {
								id: source.id,
								title: source.title,
								truncated: source.truncated,
							});
						},
					);
				} catch (e) {
					if (
						e instanceof BudgetExceeded ||
						e instanceof LeaseLost ||
						signal.aborted
					)
						throw e;
					if (
						e instanceof LlmFetchError &&
						e.retryable &&
						(state.crawlAttempt ?? 0) < 2
					) {
						next(
							{ crawlAttempt: (state.crawlAttempt ?? 0) + 1 },
							() =>
								this.store.event(job.id, "source.retry", {
									url: hit.url,
									reason: e.code,
								}),
							1000 * 2 ** (state.crawlAttempt ?? 0),
						);
						return;
					}
					next({ index: (state.index ?? 0) + 1, crawlAttempt: 0 }, () => {
						const failure = {
							id: hit.url,
							url: hit.url,
							reason: this.errorCode(e),
							code: e instanceof LlmFetchError ? e.code : "FETCH_FAILED",
						};
						this.store.put(job.id, "fetch_failure", hit.url, failure);
						this.store.event(job.id, "source.skipped", failure);
					});
				}
				return;
			}
			if (state.phase === "extract") {
				const source = this.store.record<Snapshot>(
					job.id,
					"source",
					state.sourceId ?? "",
				);
				if (!source) throw new Error("SOURCE_MISSING");
				const passages = selectSections(
					source.text,
					`${job.topic} ${query?.query ?? ""} ${source.title}`,
				);
				if (!passages.length) {
					next({ phase: "crawl", index: (state.index ?? 0) + 1 });
					return;
				}
				const previous = this.store
					.all<Claim>(job.id, "claim")
					.filter((c) => c.accepted)
					.slice(-10);
				const input = JSON.stringify({
					topic: job.topic,
					researchBrief: researchBrief(job),
					source: {
						title: source.title,
						url: source.finalUrl,
						fetchedAt: source.fetchedAt,
						readingNotice: pdfReadNotice(source.pdf),
					},
					passages,
					existingClaims: previous.map((c) => ({ id: c.id, text: c.text })),
				});
				const reserve =
					(job.config.llmProvider === "codex" ? 20000 : 0) +
					tokenReservation(input, "extract");
				job = this.store.getJob(job.id) as Job;
				if (job.usage.tokens + reserve + 4096 > job.budget.tokens)
					throw new BudgetExceeded();
				const extractedBefore =
					this.store.record<Operation>(job.id, "operation", `llm:${source.id}`)
						?.state === "done";
				const result = await this.operation(
					t,
					`llm:${source.id}`,
					{
						documents: 1,
						...splitTokenReservation(reserve, 2048),
						requests: 1,
					},
					() => p.llm.complete("extract", input, signal),
				);
				const extracted = claimResponse.safeParse(this.parse(result.text));
				if (job.mode === "live" && extracted.success && !extractedBefore) {
					next({ phase: "extract" });
					return;
				}
				const claimScope =
					job.mode === "live" &&
					extracted.success &&
					extracted.data.claims.length
						? await this.checkScope(
								t,
								job,
								p,
								`claims:${source.id}`,
								extracted.data.claims.map((c, i) => ({
									id: String(i),
									text: `${c.text}\nEvidence: ${c.quote}`,
								})),
								"claim",
								signal,
							)
						: null;
				next({ phase: "crawl", index: (state.index ?? 0) + 1 }, () => {
					this.store.put(job.id, "invocation", source.id, {
						id: source.id,
						sourceId: source.id,
						...result,
					});
					if (!extracted.success) {
						this.store.event(job.id, "llm.rejected", {
							reason: "INVALID_SCHEMA",
						});
						return;
					}
					for (const [index, item] of extracted.data.claims.entries()) {
						const decision = claimScope?.find((d) => d.id === String(index));
						if (decision && decision.status !== "in_scope") {
							this.store.event(job.id, "claim.scope_rejected", {
								sourceId: source.id,
								text: item.text,
								decision,
							});
							continue;
						}
						try {
							const location = locateEvidence(source, item.quote);
							if (!passages.some((s) => s.text.includes(location.quote)))
								throw new Error("QUOTE_OUTSIDE_SELECTED_PASSAGES");
							const e: Evidence = {
								id: uid(),
								snapshotId: source.id,
								...location,
							};
							const prior = this.store.all<Claim>(job.id, "claim");
							const duplicate = prior.find(
								(c) => normalize(c.text) === normalize(item.text),
							);
							const related = item.relatedClaimId
								? prior.find((c) => c.id === item.relatedClaimId)
								: undefined;
							const contradiction = item.relation === "contradicts";
							const kind = duplicate
								? "DUPLICATE"
								: contradiction
									? "CONTRADICTION"
									: item.confidence < 0.6
										? "WEAK_EVIDENCE"
										: "NEW";
							const c: Claim = {
								id: uid(),
								text: item.text,
								evidenceIds: [e.id],
								confidence: item.confidence,
								kind,
								accepted:
									kind === "NEW" ||
									(kind === "CONTRADICTION" &&
										!!related &&
										item.confidence >= 0.6),
								reason: contradiction
									? "原文一致を検証済みの対立する知見。両方の出典を比較する。"
									: duplicate
										? "既存Claimと重複"
										: kind === "NEW"
											? "引用の原文一致を検証済み"
											: "根拠またはconfidenceが不十分",
								relatedClaimIds: related
									? [related.id]
									: duplicate
										? [duplicate.id]
										: [],
							};
							this.store.put(job.id, "evidence", e.id, e);
							this.store.put(job.id, "claim", c.id, c);
						} catch (e) {
							this.store.event(job.id, "claim.rejected", {
								reason: this.errorCode(e),
							});
						}
					}
					if (query && !query.reason.startsWith("uncertain:"))
						for (const c of extracted.data.concepts)
							this.addQuery(job, c, query.depth + 1, query.id, "content");
				});
				return;
			}
			if (state.phase === "finalize") {
				const detail = this.store.detail(job.id);
				if (!detail) throw new Error("JOB_MISSING");
				const claims = detail.claims.filter((c) => c.accepted);
				if (!claims.length) {
					this.finish(t, state, "partial", job.reason ?? "no_verified_claims");
					return;
				}
				const generationKey = `synthesis:${job.config.generationAttempt ?? 0}`;
				let generation = this.store.record<Generation>(
					job.id,
					"generation",
					generationKey,
				);
				if (!generation) {
					generation = {
						id: generationKey,
						input: this.synthesisInput(detail),
						baseArtifactId: detail.artifacts[0]?.id ?? null,
					};
					this.store.atomic(() => {
						this.store.assertLease(t);
						this.store.put(job.id, "generation", generationKey, generation);
					});
				}
				const input = generation.input;
				const reserve =
					(job.config.llmProvider === "codex" ? 20000 : 0) +
					tokenReservation(input, "synthesize");
				const draftBefore =
					this.store.record<Operation>(job.id, "operation", generationKey)
						?.state === "done";
				const editBefore =
					this.store.record<Operation>(
						job.id,
						"operation",
						`${generationKey}:edit`,
					)?.state === "done";
				const result = await this.operation(
					t,
					`synthesis:${job.config.generationAttempt ?? 0}`,
					{ ...splitTokenReservation(reserve, 8192), requests: 1 },
					() => p.llm.complete("synthesize", input, signal),
				);
				let finalResult = result;
				if (job.mode === "live") {
					const draftResult = reportResponse.safeParse(this.parse(result.text));
					if (!draftResult.success) throw new Error("INVALID_REPORT_RESPONSE");
					const draft = draftResult.data;
					if (!draft.sections?.length) throw new Error("NARRATIVE_REQUIRED");
					if (!draftBefore) {
						next({ phase: "finalize" });
						return;
					}
					const editInput = JSON.stringify({
						...JSON.parse(input),
						previousReport: draft,
					});
					finalResult = await this.operation(
						t,
						`synthesis:${job.config.generationAttempt ?? 0}:edit`,
						{
							...splitTokenReservation(
								tokenReservation(editInput, "edit") +
									(job.config.llmProvider === "codex" ? 20000 : 0),
								8192,
							),
							requests: 1,
						},
						() => p.llm.complete("edit", editInput, signal),
					);
				}
				const validation = reportResponse.safeParse(
					this.parse(finalResult.text),
				);
				if (!validation.success) throw new Error("INVALID_REPORT_RESPONSE");
				const parsed = validation.data;
				if (job.mode === "live" && !parsed.sections?.length)
					throw new Error("NARRATIVE_REQUIRED");
				if (job.mode === "live" && !editBefore) {
					next({ phase: "finalize" });
					return;
				}
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
				const selected = ids.map(
					(id) => claims.find((c) => c.id === id) as Claim,
				);
				const artifact: Artifact = generation.artifact ?? {
					id: uid(),
					version: Math.max(0, ...detail.artifacts.map((a) => a.version)) + 1,
					title: job.topic,
					body: parsed.sections
						? parsed.sections
								.map(
									(s) =>
										`${s.title}\n\n${s.paragraphs.map((p) => p.text).join("\n\n")}`,
								)
								.join("\n\n")
						: reportBody(selected, job.mode === "mock"),
					sections: parsed.sections,
					limitations: parsed.limitations,
					openQuestions: parsed.openQuestions,
					claimIds: ids,
					generatedAt: new Date().toISOString(),
					fixture: job.mode === "mock",
				};
				if (!generation.artifact) {
					generation.artifact = artifact;
					this.store.atomic(() => {
						this.store.assertLease(t);
						this.store.put(job.id, "generation", generationKey, generation);
					});
				}
				let quality:
					| {
							id: string;
							version: number;
							rubricVersion: string;
							structural: ReturnType<typeof assessStructure>;
							review: import("zod").z.infer<typeof reviewSchema>;
							score: number;
							usage: number | null;
					  }
					| undefined;
				if (job.mode === "live") {
					const structural = assessStructure(detail, artifact);
					const reviewInput = JSON.stringify({
						...JSON.parse(input),
						artifact,
					});
					const reviewed = await this.operation(
						t,
						`synthesis:${job.config.generationAttempt ?? 0}:review`,
						{
							...splitTokenReservation(
								tokenReservation(reviewInput, "review") +
									(job.config.llmProvider === "codex" ? 20000 : 0),
								2048,
							),
							requests: 1,
						},
						() => p.llm.complete("review", reviewInput, signal),
					);
					const reviewedResult = reviewSchema.safeParse(
						this.parse(reviewed.text),
					);
					if (!reviewedResult.success)
						throw new Error("INVALID_QUALITY_REVIEW");
					const review = reviewedResult.data;
					const passed = reviewPass(structural.pass, review);
					quality = {
						id: `v${artifact.version}`,
						version: artifact.version,
						rubricVersion: REVIEW_VERSION,
						structural,
						review: { ...review, verdict: passed ? "pass" : "revise" },
						score: reviewScore(review),
						usage: reviewed.usage,
					};
					artifact.qualityState = passed ? "reviewed" : "needs_revision";
				}
				this.store.assertLease(t);
				if (
					this.store.getJob(job.id)?.status === "cancel_requested" ||
					Date.now() >= (job.deadline ?? Infinity)
				) {
					this.finish(t, state, "partial", "interrupted_finalization");
					return;
				}
				this.store.commit(
					t,
					() => {
						const current = this.store.getJob(job.id) as Job;
						if (current.status === "cancel_requested")
							throw new Error("CANCELLED");
						if (
							(this.store.detail(job.id)?.artifacts[0]?.id ?? null) !==
							generation.baseArtifactId
						)
							throw new Error("ARTIFACT_CHANGED_DURING_GENERATION");
						exportArtifact(detail, artifact, this.exportRoot);
						this.store.put(job.id, "artifact", artifact.id, artifact);
						this.store.put(job.id, "invocation", "synthesis", {
							id: "synthesis",
							...result,
						});
						for (const candidate of reportCandidates(detail, artifact))
							this.store.put(job.id, "candidate", candidate.id, candidate);
						if (quality)
							this.store.put(
								job.id,
								"quality_review",
								`v${artifact.version}`,
								quality,
							);
						current.status = "completed";
						current.reason ??= "frontier_empty";
						this.store.saveJob(current);
						this.store.event(job.id, "job.completed", {
							artifactId: artifact.id,
							claims: ids.length,
							fixture: artifact.fixture,
						});
					},
					state,
					true,
				);
				return;
			}
		} catch (e) {
			if (e instanceof LeaseLost) throw e;
			if (this.store.getJob(job.id)?.status === "cancel_requested") {
				this.finish(t, state, "cancelled", "user_cancelled");
				return;
			}
			if (signal.aborted) {
				this.finish(t, state, "partial", "deadline_or_shutdown");
				return;
			}
			if (
				state.phase === "poll" &&
				e instanceof SearchProviderError &&
				e.retryable &&
				(state.poll ?? 0) < 29
			) {
				next(
					{ poll: (state.poll ?? 0) + 1 },
					() => this.store.event(job.id, "search.retry", { reason: e.message }),
					Math.min(30000, 1000 * 2 ** Math.min(state.poll ?? 0, 5)),
				);
				return;
			}
			if (e instanceof BudgetExceeded) {
				if (state.phase === "finalize") {
					this.finish(t, state, "partial", "generation_budget_exhausted");
				} else
					next({ phase: "finalize" }, () =>
						this.reason(job.id, "budget_exhausted"),
					);
				return;
			}
			this.finish(
				t,
				state,
				this.newCount(job.id) ? "partial" : "failed",
				this.errorCode(e),
			);
		}
	}
	synthesisInput(detail: import("../../packages/contracts").JobDetail) {
		return JSON.stringify(researchInput(detail));
	}
	async checkScope(
		t: Task,
		job: Job,
		p: Providers,
		key: string,
		items: ScopeItem[],
		stage: "query" | "source" | "claim",
		signal: AbortSignal,
	) {
		const input = JSON.stringify({
			researchBrief: researchBrief(job),
			stage,
			items,
		});
		const result = await this.operation(
			t,
			`scope:${key}`,
			{
				...splitTokenReservation(
					tokenReservation(input, "scope") +
						(job.config.llmProvider === "codex" ? 20000 : 0),
					2048,
				),
				requests: 1,
			},
			() => p.llm.complete("scope", input, signal),
		);
		let decisions: ReturnType<typeof parseScope>;
		try {
			decisions = parseScope(result.text, items, stage);
		} catch {
			this.store.atomic(() => {
				this.store.assertLease(t);
				this.store.put(job.id, "scope_validation", `scope:${key}`, {
					id: `scope:${key}`,
					invalid: true,
				});
			});
			throw new Error("INVALID_SCOPE_RESPONSE");
		}
		this.store.atomic(() => {
			this.store.assertLease(t);
			this.store.put(job.id, "scope_validation", `scope:${key}`, {
				id: `scope:${key}`,
				invalid: false,
			});
			if (!this.store.record(job.id, "scope", key))
				this.store.event(job.id, "query.scope_checked", {
					stage,
					items,
					decisions,
				});
			this.store.put(job.id, "scope", key, {
				id: key,
				stage,
				items,
				decisions,
			});
		});
		return decisions;
	}

	synthesisReserve(job: Job) {
		const detail = this.store.detail(job.id);
		if (!detail) throw new Error("JOB_MISSING");
		const base = tokenReservation(this.synthesisInput(detail), "synthesize");
		const overhead = job.config.llmProvider === "codex" ? 20000 : 0;
		if (job.mode === "mock") return Math.ceil((base + overhead) * 1.2);
		// Reserve initial draft, whole-report edit, and review including a bounded draft.
		return Math.ceil((base * 3 + overhead * 3 + 2 * 8192 * 4) * 1.2);
	}

	requestCost(job: Job) {
		if (job.config.searchProvider === "codex") return 0;
		const n = Number(job.config.searchRequestUsd ?? 0.1);
		if (!Number.isFinite(n) || n <= 0)
			throw new Error("INVALID_SEARCH_COST_BOUND");
		return n;
	}
	newCount(id: string) {
		return this.store.all<Claim>(id, "claim").filter((c) => c.accepted).length;
	}
	reason(id: string, reason: string) {
		const j = this.store.getJob(id) as Job;
		if (j.status === "cancel_requested") return;
		j.reason = reason;
		j.status = "finalizing";
		this.store.saveJob(j);
	}
	errorCode(e: unknown) {
		return e instanceof Error ? e.message.slice(0, 200) : "UNKNOWN_ERROR";
	}
	parse(text: string) {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}
	async tick(jobId?: string, shutdown?: AbortSignal) {
		const slot = this.store.slot();
		if (slot.state === "blocked") return false;
		const pinned = slot.operation_key?.startsWith("pending:")
			? slot.job_id
			: undefined;
		if (pinned && jobId && pinned !== jobId) return false;
		const t = this.store.claim(30000, pinned ?? jobId);
		if (!t) return false;
		if (!this.store.acquireSlot(t)) {
			this.store.commit(t, () => {}, JSON.parse(t.payload), false, 250);
			return false;
		}
		const job = this.store.getJob(t.job_id);
		const controller = new AbortController();
		const timer = setInterval(() => {
			if (!this.store.heartbeat(t)) controller.abort(new LeaseLost());
			this.store.sql
				.query("UPDATE execution_slot SET lease_until=? WHERE owner_token=?")
				.run(Date.now() + 30000, t.token);
			const j = this.store.getJob(t.job_id);
			if (j?.status === "cancel_requested")
				controller.abort(new Error("CANCELLED"));
		}, 1000);
		const deadline = setTimeout(
			() => controller.abort(new Error("DEADLINE")),
			Math.min(
				180000,
				Math.max(1, (job?.deadline ?? Date.now() + 180000) - Date.now()),
			),
		);
		try {
			await this.step(
				t,
				shutdown
					? AbortSignal.any([controller.signal, shutdown])
					: controller.signal,
			);
		} catch (e) {
			if (!(e instanceof LeaseLost)) throw e;
		} finally {
			clearInterval(timer);
			clearTimeout(deadline);
			this.store.releaseSlot(t);
		}
		return true;
	}
}
