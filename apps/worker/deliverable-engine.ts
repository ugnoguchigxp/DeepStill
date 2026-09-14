import {
	splitTokenReservation,
	tokenBudgetFits,
} from "../../packages/research/budget";
import { pdfReadNotice } from "../../packages/core/pdf";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportArtifact } from "../../packages/artifact";
import type { Artifact, Job, Snapshot } from "../../packages/contracts";
import { canonicalUrl, terminal } from "../../packages/core";
import { BudgetExceeded, LeaseLost, type Task } from "../../packages/db";
import { sameSource } from "../../packages/research/source-identity";
import { tokenReservation } from "../../packages/llm-provider";
import { SearchProviderError } from "../../packages/search-provider";
import { emptyBundle, memoryCandidates } from "../../packages/memory";
import type { MemoryBundle } from "../../packages/memory/schema";
import {
	type Draft,
	deliverableEpisodeSchema,
	deliverableStepSchema,
	materialize,
	type ResearchAction,
	skillMarkdown,
	skillName,
	sourceLines,
} from "../../packages/research/deliverables";
function must<T>(value: T | null | undefined): T {
	if (value == null) throw Error("JOB_MISSING");
	return value;
}
import type { Engine, Providers } from "./engine";

type Target = {
	url: string;
	title: string;
	purpose: string;
	snippet?: string;
	query?: string;
	parent?: string;
	depth: number;
};
interface Flow {
	phase: "act" | "write" | "episode" | "publish";
	sequence: number;
	version: number;
	next: ResearchAction;
	draft: Draft;
	queue: Target[];
	attempted: string[];
	searched: string[];
	cursors: Record<string, number>;
	depths: Record<string, number>;
	content?: { sourceId: string; start: number; end: number; text: string };
	searchId?: string;
	searchUnavailable?: string;
	lastSearch?: { query: string; hitCount: number; newUrls: string[] };
	finishReconsidered?: number;
	failuresDetail?: {
		url: string;
		title?: string;
		code: string;
		decision: string;
		categories: string[];
	}[];
	poll: number;
	failures: number;
	noGain: number;
	reason: string;
	satisfied: boolean;
	history: {
		eventId: number;
		action: string;
		purpose: string;
		result: string;
	}[];
	repair?: string;
	repairKind?: "navigation" | "deliverable";
}
const blank = (): Draft => ({
	sections: [],
	knowledge: [],
	limitations: [],
	openQuestions: [],
});
export class DeliverableEngine {
	constructor(
		private host: Engine,
		private providers: Providers,
		private root: string,
	) {}
	get store() {
		return this.host.store;
	}
	async step(t: Task, signal: AbortSignal) {
		let job = must(this.store.getJob(t.job_id));
		let state = JSON.parse(t.payload) as Flow;
		const save = (fn = () => {}, done = false, delay = 0) =>
			this.store.commit(t, fn, state, done, delay);
		const event = (action: string, purpose: string, result: string) => {
			this.store.event(job.id, "research.action", { action, purpose, result });
			const events = this.store.events(job.id);
			state.history.push({
				eventId: events[events.length - 1].id,
				action,
				purpose,
				result,
			});
		};
		if (terminal(job.status)) {
			save(() => {}, true);
			return;
		}
		if (!job.startedAt) {
			state = {
				phase: "act",
				sequence: 0,
				version: 0,
				next: {
					kind: "search",
					query: job.topic,
					purpose: "調査の入口となる資料を探す",
				},
				draft: blank(),
				queue: [],
				attempted: [],
				searched: [],
				cursors: {},
				depths: {},
				poll: 0,
				failures: 0,
				noGain: 0,
				reason: "",
				satisfied: false,
				history: [],
			};
			const replay = job.config.deliveryReplay as
				| { sourceId: string }
				| undefined;
			if (replay)
				state.next = {
					kind: "read",
					sourceId: replay.sourceId,
					purpose: "許可済み保存本文による成果物生成の再テスト",
				};
			save(() => {
				job.status = "running";
				job.startedAt = Date.now();
				job.deadline = Date.now() + job.budget.wallMs;
				this.store.saveJob(job);
				event("start", job.topic, "本文とリンクからレポート・Knowledgeを作成");
			});
			return;
		}
		if (job.status === "cancel_requested") {
			save(() => {
				job.status = "cancelled";
				job.reason = "user_cancelled";
				this.store.saveJob(job);
				this.store.event(job.id, "job.cancelled", {});
			}, true);
			return;
		}
		if (
			job.deadline &&
			Date.now() >= job.deadline &&
			!["publish"].includes(state.phase)
		) {
			state.reason = "time_budget";
			state.satisfied = false;
			state.phase = "publish";
		}
		const end = (reason: string) => {
			state.reason = reason;
			state.satisfied = false;
			state.phase = "episode";
		};
		const reconsider = () => {
			state.content = undefined;
			state.phase = "write";
		};
		try {
			if (state.phase === "act") {
				const action = state.next;
				if (
					job.config.deliveryReplay &&
					["search", "fetch"].includes(action.kind)
				) {
					end("saved_evidence_only");
					save();
					return;
				}
				if (action.kind === "finish") {
					state.satisfied = action.satisfied && !job.config.deliveryReplay;
					state.reason = job.config.deliveryReplay
						? "saved_evidence_only"
						: action.satisfied
							? "satisfied"
							: "unresolved_questions";
					state.phase = "episode";
					save(() => event("finish", action.reason, state.reason));
					return;
				}
				if (action.kind === "read") {
					const source = this.store.record<Snapshot>(
						job.id,
						"source",
						action.sourceId,
					);
					if (!source) throw Error("UNKNOWN_READ_SOURCE");
					const start = state.cursors[source.id] ?? 0;
					if (start >= source.text.length) {
						state.repair =
							"この資料は全文既読です。他のリンクか新規検索で不足を補ってください。";
						state.repairKind = "navigation";
						state.phase = "write";
						save();
						return;
					}
					// Small documents are delivered whole; long documents use deterministic Unicode-safe chunks.
					let endOffset = start,
						bytes = 0;
					for (const line of sourceLines(source.text).filter(
						(l) => l.start >= start,
					)) {
						const n = Buffer.byteLength(line.text);
						if (bytes + n > 24000) break;
						bytes += n;
						endOffset = line.end;
					}
					state.content = {
						sourceId: source.id,
						start,
						end: endOffset,
						text: source.text.slice(start, endOffset),
					};
					state.cursors[source.id] = endOffset;
					state.phase = "write";
					save(() =>
						event(
							"read",
							action.purpose,
							`${source.title}: ${start}–${endOffset}/${source.text.length}`,
						),
					);
					return;
				}
				if (action.kind === "search") {
					if (!state.searchId) {
						if (state.searched.includes(action.query.trim().toLowerCase())) {
							end("repeated_search");
							save();
							return;
						}
						if (job.usage.queries >= job.budget.queries) {
							end("query_budget");
							save();
							return;
						}
						const r = await this.host.operation(
							t,
							`delivery:${state.sequence}:search-submit`,
							{
								requests: 1,
								queries: 1,
								costUsd: Number(job.config.searchRequestUsd ?? 0),
							},
							() => this.providers.search.submit(action.query, signal),
						);
						state.searchId = r.id;
						state.poll = 0;
						state.searched.push(action.query.trim().toLowerCase());
						save(() => {
							this.store.put(job.id, "query", `q:${state.sequence}`, {
								id: `q:${state.sequence}`,
								query: action.query,
								depth: 0,
								score: 0,
								reason: action.purpose,
								status: "searched",
								known: "unverified",
							});
							event("search", action.purpose, action.query);
						});
						return;
					}
					if (state.poll >= 20) {
						end("search_timeout");
						save();
						return;
					}
					const r = await this.host.operation(
						t,
						`delivery:${state.sequence}:search-poll:${state.poll}`,
						{ requests: 1 },
						() => this.providers.search.poll(must(state.searchId), signal),
					);
					state.poll++;
					if (!r.ready) {
						save(() => {}, false, 1000);
						return;
					}
					const hits = r.hits
						.filter((h) => /^https?:\/\//.test(h.url))
						.map((h) => ({ ...h, url: canonicalUrl(h.url) }));
					state.queue.push(
						...hits
							.filter((h) => !state.queue.some((q) => q.url === h.url))
							.map((h) => ({
								url: h.url,
								title: h.title,
								snippet: h.snippet.slice(0, 1200),
								query: action.query,
								purpose: action.purpose,
								depth: 0,
							})),
					);
					state.lastSearch = {
						query: action.query,
						hitCount: hits.length,
						newUrls: hits.map((h) => h.url),
					};
					const searchSequence = state.sequence;
					state.searchId = undefined;
					state.sequence++;
					reconsider();
					save(() => {
						this.store.put(
							job.id,
							"delivery_search",
							String(searchSequence),
							hits,
						);
						this.store.event(job.id, "search.completed", {
							hits: hits.length,
							query: action.query,
						});
					});
					return;
				}
				if (action.kind === "fetch") {
					const url = canonicalUrl(action.url);
					const sources = this.store.all<Snapshot>(job.id, "source");
					const found = sources.find(
						(s) =>
							canonicalUrl(s.finalUrl) === url || canonicalUrl(s.url) === url,
					);
					if (found) {
						state.next = {
							kind: "read",
							sourceId: found.id,
							purpose: action.purpose,
						};
						save();
						return;
					}
					if (state.attempted.includes(url)) {
						reconsider();
						save();
						return;
					}
					if (
						job.usage.urls >= job.budget.urls ||
						job.usage.documents >= job.budget.documents
					) {
						end("source_budget");
						save();
						return;
					}
					const discovered =
						state.queue.find((q) => q.url === url) ||
						sources
							.flatMap((s) =>
								(s.links ?? []).map((l) => ({
									url: l.url,
									parent: s.id,
									depth: (state.depths[canonicalUrl(s.finalUrl)] ?? 0) + 1,
								})),
							)
							.find((l) => l.url === url);
					if (discovered && discovered.depth > job.budget.depth) {
						reconsider();
						save();
						return;
					}
					// Current target may already have been dequeued; its provenance/depth was persisted.
					let source: Snapshot;
					try {
						source = await this.host.operation(
							t,
							`crawl:delivery:${state.sequence}`,
							{ requests: 1, urls: 1 },
							() => this.providers.crawler.crawl(url, signal),
						);
					} catch (error) {
						if (
							error instanceof LeaseLost ||
							signal.aborted ||
							error instanceof BudgetExceeded
						)
							throw error;
						state.attempted.push(url);
						state.sequence++;
						state.failures++;
						const reason =
							error instanceof Error ? error.message : "FETCH_FAILED";
						const detail = error as {
							code?: string;
							guardDecision?: string;
							warningCategories?: string[];
						};
						const diagnostic = {
							url,
							title: state.queue.find((q) => q.url === url)?.title,
							code: detail.code ?? "FETCH_FAILED",
							decision: detail.guardDecision ?? "",
							categories: detail.warningCategories ?? [],
						};
						state.failuresDetail = [
							...(state.failuresDetail ?? []),
							diagnostic,
						];
						reconsider();
						save(() => {
							this.store.event(job.id, "source.skipped", {
								unread: true,
								reason,
								...diagnostic,
							});
							event("fetch", action.purpose, `${url}: 未読 — ${reason}`);
						});
						return;
					}
					state.attempted.push(url);
					state.sequence++;
					state.failures = 0;
					const duplicate = sources.find(
						(s) => !s.pdf && !source.pdf && !!s.text && s.text === source.text,
					);
					if (duplicate) {
						// Identical allowed text adds no evidence, but may expose new links.
						for (const link of source.links ?? [])
							if (!state.queue.some((q) => q.url === link.url))
								state.queue.push({
									url: link.url,
									title: link.text,
									purpose: link.context,
									parent: duplicate.id,
									depth: (discovered?.depth ?? 0) + 1,
								});
						if ((state.cursors[duplicate.id] ?? 0) < duplicate.text.length)
							state.next = {
								kind: "read",
								sourceId: duplicate.id,
								purpose: action.purpose,
							};
						else reconsider();
						save(() => {
							this.store.event(job.id, "source.duplicate", {
								url,
								sourceId: duplicate.id,
							});
							event(
								"fetch",
								action.purpose,
								`${url}: 保存済み本文と一致。新しいリンクのみ候補に追加`,
							);
						});
						return;
					}
					state.depths[canonicalUrl(source.finalUrl)] =
						discovered?.depth ?? state.depths[url] ?? 0;
					state.next = {
						kind: "read",
						sourceId: source.id,
						purpose: action.purpose,
					};
					save(() => {
						this.store.put(job.id, "source", source.id, source);
						const fresh = must(this.store.getJob(job.id));
						fresh.usage.documents++;
						this.store.saveJob(fresh);
						this.store.event(job.id, "source.saved", {
							id: source.id,
							url: source.finalUrl,
							title: source.title,
						});
						if (discovered?.parent)
							this.store.put(
								job.id,
								"source_edge",
								`${discovered.parent}:${source.id}`,
								{ from: discovered.parent, to: source.id },
							);
						event("fetch", action.purpose, `${source.title}: 保存成功`);
					});
					return;
				}
			}
			if (state.phase === "write") {
				const content = state.content;
				const sources = this.store.all<Snapshot>(job.id, "source");
				const recoveryExhausted = state.failures >= 8;
				// A retrieval stop adds no evidence. Preserve the last validated draft;
				// asking the writer to finalize here can silently discard explanations.
				if (recoveryExhausted && !content) {
					end("retrieval_recovery_limit");
					save(() => {
						this.store.event(job.id, "research.decision", {
							actor: "runtime",
							action: "finish",
							purpose: "連続取得失敗の上限に到達。検証済みの成果物を保持する",
							target: "",
							trigger: "retrieval_recovery_limit",
						});
						event("finish", "取得回復上限のため未充足終了", state.reason);
					});
					return;
				}
				const navigationOnly =
					!content &&
					!recoveryExhausted &&
					(!state.repair || state.repairKind === "navigation") &&
					!job.config.deliveryReplay;
				const input = JSON.stringify({
					navigationOnly,
					originalRequest: job.topic,
					readableSourceIds: sources
						.filter((s) => (state.cursors[s.id] ?? 0) < s.text.length)
						.map((s) => s.id),
					unresolvedQuestions: state.draft.openQuestions,
					draft: navigationOnly ? undefined : state.draft,
					reportState: navigationOnly
						? {
								sections: state.draft.sections.map((s) => s.title),
								openQuestions: state.draft.openQuestions,
								limitations: state.draft.limitations,
							}
						: undefined,
					newContent: content
						? {
								sourceId: content.sourceId,
								start: content.start,
								end: content.end,
								lines: sourceLines(
									must(sources.find((s) => s.id === content?.sourceId)).text,
								)
									.filter(
										(l) => l.start >= content.start && l.end <= content.end,
									)
									.map((l) => ({ number: l.number, text: l.text })),
							}
						: null,
					sources: sources.map((s) => ({
						id: s.id,
						title: s.title,
						url: s.finalUrl,
						readUntil: state.cursors[s.id] ?? 0,
						length: s.text.length,
						readingNotice: pdfReadNotice(s.pdf),
						readable: (state.cursors[s.id] ?? 0) < s.text.length,
						headings: s.id === content?.sourceId ? (s.headings ?? []) : [],
						links: (s.links ?? [])
							.filter(
								(l) =>
									!state.attempted.includes(l.url) &&
									(state.depths[canonicalUrl(s.finalUrl)] ?? 0) + 1 <=
										job.budget.depth,
							)
							.slice(0, s.id === content?.sourceId ? 400 : 5)
							.map((l, index) =>
								index < 30
									? { ...l, context: l.context.slice(0, 240) }
									: { url: l.url, text: l.text, kind: l.kind },
							),
					})),
					discoveries: state.queue
						.filter(
							(q) =>
								!state.attempted.includes(q.url) && q.depth <= job.budget.depth,
						)
						.slice(-40),
					recentActions: state.history.slice(-5),
					lastSearch: state.lastSearch ?? null,
					retrievalFailures: (state.failuresDetail ?? []).slice(-8),
					newSearchCandidates: state.queue
						.filter(
							(q) =>
								state.lastSearch?.newUrls.includes(q.url) &&
								!state.attempted.includes(q.url),
						)
						.map((q) => q.url),
					remainingTokens: job.budget.tokens - job.usage.tokens,
					remainingInputTokens:
						(job.budget.inputTokens ?? job.budget.tokens) -
						(job.usage.inputTokens ?? job.usage.tokens),
					remainingOutputTokens:
						(job.budget.outputTokens ?? job.budget.tokens) -
						(job.usage.outputTokens ?? job.usage.tokens),
					remainingQueries: state.searchUnavailable
						? 0
						: job.budget.queries - job.usage.queries,
					searchUnavailable: state.searchUnavailable ?? null,
					remainingUrls: job.budget.urls - job.usage.urls,
					searchedQueries: state.searched,
					consecutiveFailures: state.failures,
					stopConstraint: recoveryExhausted ? "retrieval_recovery_limit" : null,
					validationError: state.repair ?? null,
					finalizing: !!job.config.deliveryReplay || recoveryExhausted,
				});
				const reserve =
					tokenReservation(input, "deliverable_step") +
					(job.config.llmProvider === "codex" ? 16000 : 0);
				if (
					Buffer.byteLength(input) > 100000 ||
					!tokenBudgetFits(job, splitTokenReservation(reserve + 22000, 15000))
				) {
					end("token_budget");
					save(() => {
						this.store.event(job.id, "budget.navigation_blocked", {
							used: job.usage.tokens,
							remaining: job.budget.tokens - job.usage.tokens,
							reservation: reserve,
							directionalReservation: splitTokenReservation(reserve, 12000),
							directionalUsage: {
								inputTokens: job.usage.inputTokens,
								outputTokens: job.usage.outputTokens,
							},
							directionalBudget: {
								inputTokens: job.budget.inputTokens,
								outputTokens: job.budget.outputTokens,
							},
							episodeAllowance: 22000,
							inputBytes: Buffer.byteLength(input),
							navigationOnly,
							repairKind: state.repairKind ?? null,
						});
						event(
							"budget_stop",
							"次の判断用の予約枠を確保できない",
							`使用済み${job.usage.tokens}、予約${reserve}、Episode余白22000、上限${job.budget.tokens}`,
						);
					});
					return;
				}
				const r = await this.host.operation(
					t,
					`delivery:${state.sequence}:deliverable_step`,
					{ requests: 1, ...splitTokenReservation(reserve, 12000) },
					() => this.providers.llm.complete("deliverable_step", input, signal),
				);
				state.sequence++;
				try {
					const parsed = deliverableStepSchema.parse(JSON.parse(r.text));
					if (content && parsed.draft === null)
						throw Error("READ_CONTENT_REQUIRES_DRAFT_UPDATE");
					const output = { ...parsed, draft: parsed.draft ?? state.draft };
					if (recoveryExhausted && output.next.kind !== "finish")
						throw Error("RECOVERY_LIMIT_FINISH_REQUIRED");
					const result = materialize(
						output.draft,
						sources,
						job.id,
						state.version + 1,
						job.topic,
					);
					// Source quotes must come from ranges actually delivered, not merely fetched text.
					for (const e of result.evidence)
						if (e.end > (state.cursors[e.snapshotId] ?? 0))
							throw Error("CITATION_NOT_READ");
					if (output.next.kind === "fetch") {
						const url = canonicalUrl(output.next.url);
						const candidate = {
							url,
							title: state.queue.find((q) => q.url === url)?.title,
						};
						if (
							(state.failuresDetail ?? []).some(
								(failure) =>
									["deny", "require_approval"].includes(failure.decision) &&
									sameSource(candidate, failure),
							)
						)
							throw Error("WITHHELD_SOURCE_ALIAS_USE_INDEPENDENT_EVIDENCE");
						if (
							!state.queue.some((q) => q.url === url) &&
							!sources.some((s) => (s.links ?? []).some((l) => l.url === url))
						)
							throw Error("UNDISCOVERED_URL");
						if (state.attempted.includes(url))
							throw Error("URL_ALREADY_ATTEMPTED");
						const depth =
							state.queue.find((q) => q.url === url)?.depth ??
							sources.reduce(
								(n, s) =>
									(s.links ?? []).some((l) => l.url === url)
										? Math.min(
												n,
												(state.depths[canonicalUrl(s.finalUrl)] ?? 0) + 1,
											)
										: n,
								Infinity,
							);
						if (depth > job.budget.depth) throw Error("DEPTH_LIMIT");
						output.next.url = url;
					}
					const nextAction = output.next;
					if (nextAction.kind === "search" && state.searchUnavailable)
						throw Error("SEARCH_UNAVAILABLE_USE_KNOWN_SOURCES_OR_FINISH");
					if (
						nextAction.kind === "read" &&
						!sources.some((s) => s.id === nextAction.sourceId)
					)
						throw Error("UNKNOWN_READ_SOURCE");
					if (
						nextAction.kind === "read" &&
						(state.cursors[nextAction.sourceId] ?? 0) >=
							must(sources.find((s) => s.id === nextAction.sourceId)).text
								.length
					)
						throw Error("SOURCE_ALREADY_READ");
					if (
						nextAction.kind === "search" &&
						state.searched.includes(nextAction.query.trim().toLowerCase())
					)
						throw Error("QUERY_ALREADY_SEARCHED");
					if (
						nextAction.kind === "finish" &&
						nextAction.satisfied &&
						(!output.draft.sections.length || output.draft.openQuestions.length)
					)
						throw Error("UNRESOLVED_REQUEST");
					if (
						nextAction.kind === "finish" &&
						!nextAction.satisfied &&
						!job.config.deliveryReplay &&
						!recoveryExhausted &&
						!state.finishReconsidered &&
						!state.searchUnavailable &&
						job.usage.queries < job.budget.queries &&
						tokenBudgetFits(
							this.store.getJob(job.id)!,
							splitTokenReservation(reserve + 22000, 15000),
						)
					) {
						state.finishReconsidered = 1;
						state.repairKind = "navigation";
						state.draft = output.draft;
						state.content = undefined;
						state.repair =
							"未解決の問いと予算が残っています。検索0件なら未確定の略語を引用符で固定せず、展開語や別の切り口で検索してください。拒否URLの再取得は禁止です。追加経路が不適切なら、その具体的理由で未充足終了してください。";
						save(() =>
							event(
								"reconsider",
								"未解決の問いに対して別の切り口を確認",
								nextAction.reason,
							),
						);
						return;
					}
					const unchanged =
						JSON.stringify(state.draft) === JSON.stringify(output.draft);
					state.noGain = content && unchanged ? state.noGain + 1 : 0;
					state.draft = output.draft;
					if (!unchanged) state.version++;
					state.next = output.next;
					state.content = undefined;
					state.repair = undefined;
					state.repairKind = undefined;
					state.phase = "act";
					if (recoveryExhausted) end("retrieval_recovery_limit");
					save(() => {
						const parent =
							nextAction.kind === "fetch"
								? sources.find((s) =>
										(s.links ?? []).some((l) => l.url === nextAction.url),
									)?.id
								: undefined;
						this.store.event(job.id, "research.decision", {
							actor: "llm",
							action: nextAction.kind,
							purpose:
								nextAction.kind === "finish"
									? nextAction.reason
									: nextAction.purpose,
							target:
								nextAction.kind === "fetch"
									? nextAction.url
									: nextAction.kind === "search"
										? nextAction.query
										: nextAction.kind === "read"
											? nextAction.sourceId
											: "",
							parentSourceId: parent ?? null,
							trigger: content
								? "source_read"
								: state.history.at(-1)?.action === "search"
									? "search_results"
									: "retrieval_failed",
						});
						if (unchanged) return;
						for (const c of result.claims)
							this.store.put(job.id, "claim", c.id, c);
						for (const e of result.evidence)
							this.store.put(job.id, "evidence", e.id, e);
						this.persistDraft(job, state, result.artifact, result.knowledge);
						this.store.event(job.id, "deliverable.updated", {
							version: state.version,
							paragraphs: output.draft.sections.reduce(
								(n, s) => n + s.paragraphs.length,
								0,
							),
							knowledge: output.draft.knowledge.length,
						});
					});
					return;
				} catch (error) {
					if (state.repair) {
						end("invalid_deliverable");
						save();
						return;
					}
					state.repair = String(error).slice(0, 1000);
					state.repairKind = navigationOnly ? "navigation" : "deliverable";
					save(() => {
						this.store.event(job.id, "deliverable.invalid", {
							reason: state.repair,
						});
						event("invalid_action", "判断の訂正", state.repair ?? "invalid");
					});
					return;
				}
			}
			if (state.phase === "episode") {
				const input = JSON.stringify({
					originalRequest: job.topic,
					reason: state.reason,
					satisfied: state.satisfied,
					events: state.history,
					report: state.draft.sections,
					openQuestions: state.draft.openQuestions,
					limitations: state.draft.limitations,
				});
				const reserve =
					tokenReservation(input, "deliverable_episode") +
					(job.config.llmProvider === "codex" ? 16000 : 0);
				if (!tokenBudgetFits(job, splitTokenReservation(reserve, 3000))) {
					state.phase = "publish";
					save();
					return;
				}
				const r = await this.host.operation(
					t,
					`delivery:${state.sequence}:deliverable_episode`,
					{ requests: 1, ...splitTokenReservation(reserve, 3000) },
					() =>
						this.providers.llm.complete("deliverable_episode", input, signal),
				);
				state.sequence++;
				const episode = deliverableEpisodeSchema.parse(JSON.parse(r.text));
				state.phase = "publish";
				save(() =>
					this.store.put(job.id, "delivery_episode", "episode", {
						...episode,
						id: "episode",
					}),
				);
				return;
			}
			if (state.phase === "publish") {
				if (!state.version) state.version = 1;
				const sources = this.store.all<Snapshot>(job.id, "source");
				const result = materialize(
					state.draft,
					sources,
					job.id,
					state.version + 1,
					job.topic,
				);
				state.version++;
				job = must(this.store.getJob(job.id));
				save(() => {
					job.status =
						state.satisfied && result.artifact.claimIds.length
							? "completed"
							: "partial";
					job.reason = state.reason || "unresolved_questions";
					this.store.saveJob(job);
					for (const c of result.claims)
						this.store.put(job.id, "claim", c.id, c);
					for (const e of result.evidence)
						this.store.put(job.id, "evidence", e.id, e);
					const memory = this.persistDraft(
						job,
						state,
						result.artifact,
						result.knowledge,
						true,
					);
					this.store.event(job.id, `job.${job.status}`, {
						artifactId: result.artifact.id,
					});
					this.store.put(job.id, "delivery_result", "result", {
						memoryId: memory.id,
						artifactId: result.artifact.id,
						reason: job.reason,
						independentReview: "not_run",
					});
				}, true);
				exportArtifact(
					must(this.store.detail(job.id)),
					result.artifact,
					this.root,
				);
				for (const k of state.draft.knowledge.filter((k) => k.skill)) {
					const dir = join(
						this.root,
						job.id,
						String(result.artifact.version),
						"skills",
						skillName(k.skill?.name ?? k.title),
					);
					mkdirSync(dir, { recursive: true });
					writeFileSync(join(dir, "SKILL.md"), skillMarkdown(k));
				}
			}
		} catch (error) {
			if (error instanceof LeaseLost) throw error;
			if (signal.aborted) throw error;
			if (error instanceof SearchProviderError && !error.retryable) {
				state.searchUnavailable = error.message;
				state.searchId = undefined;
				state.sequence++;
				reconsider();
				save(() =>
					event(
						"search_failed",
						"検索を停止し既知の資料から再検討",
						error.message,
					),
				);
				return;
			}
			if (error instanceof BudgetExceeded) {
				state.reason = "token_budget";
				state.satisfied = false;
				state.phase = "publish";
				save();
				return;
			}
			throw error;
		}
	}
	private persistDraft(
		job: Job,
		state: Flow,
		artifact: Artifact,
		knowledge: ReturnType<typeof materialize>["knowledge"],
		final = false,
	) {
		const memory = emptyBundle(must(this.store.detail(job.id)));
		memory.id = `memory:delivery:${job.id}:${state.version}`;
		memory.knowledge = knowledge;
		const episode = this.store.record<
			ReturnType<typeof deliverableEpisodeSchema.parse>
		>(job.id, "delivery_episode", "episode");
		if (final)
			memory.episodes = [
				{
					...(episode ?? {
						title: job.topic,
						context: job.topic,
						intent: job.topic,
						observations:
							state.history
								.map((h) => h.result)
								.join("\n")
								.slice(-2400) || "本文なし",
						decisions: [],
						actionTaken: state.history.map((h) => h.action).join(" → "),
						outcome: state.reason,
						outcomeKind: "unknown" as const,
						failedApproach: [],
						lesson: "自動生成用予算が不足したため実行記録のみを保存。",
						triggers: [job.topic],
						openLoops: state.draft.openQuestions,
					}),
					id: `episode:${job.id}`,
					eventIds: state.history.map((h) => h.eventId).slice(-60),
					claimIds: artifact.claimIds.slice(0, 30),
				},
			];
		artifact.memoryId = memory.id;
		artifact.fixture = job.mode === "mock";
		this.store.put(job.id, "memory", memory.id, memory);
		this.store.put(job.id, "artifact", artifact.id, artifact);
		for (const c of memoryCandidates(memory, artifact))
			this.store.put(job.id, "candidate", c.id, c);
		return memory as MemoryBundle;
	}
}
