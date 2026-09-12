import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { currentCandidates } from "../artifact/research";
import type { Event, Job, JobDetail, JobInput, Usage } from "../contracts";
import { terminal } from "../core";
import type { ResearchState, Round, WorkItem } from "../research/rounds";
import { records } from "./schema";
export const uid = () => crypto.randomUUID();
export class LeaseLost extends Error {
	constructor() {
		super("LEASE_LOST");
	}
}
export class BudgetExceeded extends Error {
	constructor() {
		super("BUDGET_EXHAUSTED");
	}
}
export interface Task {
	id: string;
	job_id: string;
	state: string;
	payload: string;
	token: string;
	lease_until: number;
	attempts: number;
	next_at: number;
}
const zero = (): Usage => ({
	queries: 0,
	urls: 0,
	documents: 0,
	tokens: 0,
	requests: 0,
	costUsd: 0,
});
export class Store {
	readonly sql: Database;
	readonly orm;
	constructor(
		public path = process.env.DATABASE_URL || "data/deepstill.sqlite",
	) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.sql = new Database(path, { create: true });
		this.sql.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		this.orm = drizzle(this.sql);
	}
	migrate() {
		for (const version of [1, 2, 3]) {
			const source = readFileSync(
				new URL(
					`./migrations/${String(version).padStart(4, "0")}.sql`,
					import.meta.url,
				),
				"utf8",
			);
			const checksum = new Bun.CryptoHasher("sha256")
				.update(source)
				.digest("hex");
			this.atomic(() => {
				this.sql.exec(
					"CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)",
				);
				const previous = this.sql
					.query("SELECT checksum FROM migrations WHERE version=?")
					.get(version) as { checksum: string } | null;
				if (previous) {
					if (previous.checksum !== checksum)
						throw new Error("MIGRATION_CHECKSUM_MISMATCH");
					return;
				}
				this.sql.exec(source);
				if (this.sql.query("PRAGMA foreign_key_check").all().length)
					throw new Error("MIGRATION_FOREIGN_KEY_FAILURE");
				this.sql
					.query("INSERT INTO migrations VALUES(?,?)")
					.run(version, checksum);
			});
		}
	}

	ready() {
		return !!this.sql
			.query("SELECT version FROM migrations WHERE version=3")
			.get();
	}
	atomic<T>(fn: () => T): T {
		return this.sql.transaction(fn).immediate();
	}
	getJob(id: string) {
		const r = this.sql.query("SELECT data FROM jobs WHERE id=?").get(id) as {
			data: string;
		} | null;
		return r ? (JSON.parse(r.data) as Job) : null;
	}
	listJobs() {
		return (
			this.sql
				.query("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 200")
				.all() as { data: string }[]
		).map((r) => JSON.parse(r.data) as Job);
	}
	deleteJob(
		id: string,
		roots = [
			process.env.ARTIFACT_ROOT || "data/artifacts",
			"data/artifacts",
			"data/reviews",
		],
	) {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				id,
			)
		)
			throw new Error("INVALID_JOB_ID");
		return this.atomic(() => {
			if (!this.getJob(id)) return false;
			const slot = this.slot();
			if (slot.job_id === id && slot.operation_key)
				this.sql
					.query(
						"INSERT INTO execution_events(type,data,created_at) VALUES(?,?,?)",
					)
					.run(
						"deleted_operation_pending",
						JSON.stringify({ operationKey: slot.operation_key }),
						Date.now(),
					);
			// Hold the writer lock across file cleanup and lease removal so exporters
			// cannot recreate files after deletion. On failure the DB remains retryable.
			for (const root of new Set(roots))
				rmSync(join(root, id), { recursive: true, force: true });
			for (const table of ["research_work_items", "records", "events", "tasks"])
				this.sql.query(`DELETE FROM ${table} WHERE job_id=?`).run(id);
			this.sql
				.query(
					"UPDATE execution_slot SET state=CASE WHEN operation_key IS NULL THEN 'idle' ELSE 'blocked' END,owner_token=CASE WHEN operation_key IS NULL THEN '' ELSE owner_token END,lease_until=0,job_id=NULL WHERE job_id=?",
				)
				.run(id);
			this.sql.query("DELETE FROM jobs WHERE id=?").run(id);
			return true;
		});
	}

	saveJob(j: Job) {
		j.updatedAt = Date.now();
		this.sql
			.query("UPDATE jobs SET data=? WHERE id=?")
			.run(JSON.stringify(j), j.id);
	}
	create(input: JobInput) {
		return this.atomic(() => {
			const now = Date.now();
			const j: Job = {
				...input,
				id: uid(),
				usage: zero(),
				status: "queued",
				reason: null,
				createdAt: now,
				startedAt: null,
				deadline: null,
				updatedAt: now,
				config: {
					strategyVersion: "round-v2",
					searchExecutionGuarantee:
						process.env.SEARCH_PROVIDER === "codex"
							? "provider_managed"
							: "single_request",
					engineVersion:
						process.env.ROUND_ENGINE_ENABLED === "0"
							? 1
							: (input.engineVersion ?? 2),
					llmProvider:
						input.mode === "mock"
							? "fixture"
							: process.env.LLM_PROVIDER || "compatible",
					searchProvider:
						input.mode === "mock"
							? "fixture"
							: process.env.SEARCH_PROVIDER || "dataforseo",
					reasoning: process.env.LLM_PROVIDER === "codex" ? "low" : null,
					llmModel:
						input.mode === "mock"
							? "fixture-v1"
							: process.env.LLM_PROVIDER === "codex"
								? "gpt-5.6-luna"
								: process.env.LLM_MODEL,
					extractor: "llm-fetch@0.1.0",
					promptVersion: "5",
 memoryVersion: 1,
					searchRequestUsd: Number(
						process.env.DATAFORSEO_MAX_REQUEST_USD || 0.1,
					),
					llmBaseUrl: process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1",
					searchLocationCode: Number(
						process.env.DATAFORSEO_LOCATION_CODE || 2392,
					),
					searchLanguageCode: process.env.DATAFORSEO_LANGUAGE_CODE || "ja",
					saturationLowRounds: 2,
					saturationMinimumRounds: 3,
				},
			};
			this.sql
				.query("INSERT INTO jobs VALUES(?,?)")
				.run(j.id, JSON.stringify(j));
			this.sql
				.query("INSERT INTO tasks(id,job_id,state,payload) VALUES(?,?,?,?)")
				.run(
					uid(),
					j.id,
					"pending",
					JSON.stringify({ phase: "seed", round: 0, lowGain: 0 }),
				);
			this.event(j.id, "job.created", { mode: j.mode });
			return j;
		});
	}
	put<T>(jobId: string, kind: string, id: string, data: T) {
		this.orm
			.insert(records)
			.values({ jobId, kind, id, data: JSON.stringify(data) })
			.onConflictDoUpdate({
				target: [records.jobId, records.kind, records.id],
				set: { data: JSON.stringify(data) },
			})
			.run();
	}
	all<T>(jobId: string, kind: string): T[] {
		return this.orm
			.select()
			.from(records)
			.where(and(eq(records.jobId, jobId), eq(records.kind, kind)))
			.all()
			.map((r) => JSON.parse(r.data) as T);
	}
	record<T>(jobId: string, kind: string, id: string): T | undefined {
		return this.all<T & { id: string }>(jobId, kind).find((r) => r.id === id);
	}
	event(jobId: string, type: string, data: unknown) {
		this.sql
			.query("INSERT INTO events(job_id,type,data,created_at) VALUES(?,?,?,?)")
			.run(jobId, type, JSON.stringify(data), Date.now());
	}
	events(jobId: string, after = 0): Event[] {
		return (
			this.sql
				.query(
					"SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 500",
				)
				.all(jobId, after) as {
				id: number;
				job_id: string;
				type: string;
				data: string;
				created_at: number;
			}[]
		).map((r) => ({
			id: r.id,
			jobId: r.job_id,
			type: r.type,
			data: JSON.parse(r.data),
			createdAt: r.created_at,
		}));
	}
	detail(id: string): JobDetail | null {
		const job = this.getJob(id);
		if (!job) return null;
		return {
			job,
			queries: this.all(id, "query"),
			edges: this.all(id, "edge"),
			sources: this.all(id, "source"),
			evidence: this.all(id, "evidence"),
			claims: this.all(id, "claim"),
			qualityReviews: this.all(id, "quality_review"),
 memory: this.all<import("../memory/schema").MemoryBundle>(id, "memory").sort((a,b)=>b.asOf.localeCompare(a.asOf)),
 memoryBrief: this.record(id, "brief", "brief") ?? undefined,
			artifacts: this.all<import("../contracts").Artifact>(id, "artifact").sort(
				(a, b) => b.version - a.version,
			),
			candidates: currentCandidates(
				this.all(id, "candidate"),
				this.all(id, "artifact"),
			),
			events: this.events(
				id,
				Math.max(
					0,
					Number(
						(
							this.sql
								.query("SELECT max(id) AS id FROM events WHERE job_id=?")
								.get(id) as { id: number | null }
						).id ?? 0,
					) - 500,
				),
			),
			operations: this.all(id, "operation"),
			research: job.config.engineVersion === 2 ? this.research(id) : undefined,
		};
	}
	cancel(id: string) {
		return this.atomic(() => {
			const j = this.getJob(id);
			if (!j) return null;
			if (!terminal(j.status)) {
				const task = this.sql
					.query("SELECT * FROM tasks WHERE job_id=?")
					.get(id) as Task | null;
				const idle =
					task &&
					(task.state === "pending" ||
						(task.state === "running" && task.lease_until < Date.now()));
				j.status = idle ? "cancelled" : "cancel_requested";
				const slot = this.slot();
				if (slot.job_id === id && slot.operation_key?.startsWith("pending:")) {
					this.sql
						.query("UPDATE execution_slot SET state='blocked' WHERE id=1")
						.run();
					this.event(id, "operation.stop_confirmation_required", {
						operationKey: slot.operation_key,
					});
				}
				if (idle) {
					j.reason = "user_cancelled";
					this.sql
						.query(
							"UPDATE tasks SET state='done',token='',lease_until=0 WHERE id=?",
						)
						.run(task.id);
				}
				this.saveJob(j);
				this.event(id, idle ? "job.cancelled" : "job.cancel_requested", {});
			}
			return j;
		});
	}
	resume(id: string) {
		return this.atomic(() => {
			const j = this.getJob(id);
			if (!j) return null;
			if (!["cancelled", "failed", "partial"].includes(j.status))
				throw new Error("JOB_NOT_RESUMABLE");
			const task = this.sql
				.query("SELECT * FROM tasks WHERE job_id=? AND state='done' LIMIT 1")
				.get(id) as Task | null;
			if (!task) throw new Error("JOB_NOT_RESUMABLE");
			if (this.slot().state === "blocked" && this.slot().job_id === id)
				throw new Error("EXTERNAL_STOP_CONFIRMATION_REQUIRED");
			const phase = JSON.parse(task.payload).phase;
			const cached = this.record<{ state: string }>(
				id,
				"operation",
				`synthesis:${j.config.generationAttempt ?? 0}`,
			);
			const invalidReasons = [
				"ARTIFACT_CHANGED_DURING_GENERATION",
				"INVALID_REPORT_RESPONSE",
				"INVALID_QUALITY_REVIEW",
				"NARRATIVE_REQUIRED",
				"INVALID_CLAIM_REFERENCE",
				"INVALID_EVIDENCE_REFERENCE",
			];
			const canPublishCached =
				phase === "finalize" &&
				cached?.state === "done" &&
				(j.mode === "mock" ||
					["edit", "review"].every(
						(stage) =>
							this.record<{ state: string }>(
								id,
								"operation",
								`synthesis:${j.config.generationAttempt ?? 0}:${stage}`,
							)?.state === "done",
					)) &&
				!invalidReasons.includes(j.reason || "");
			if (!canPublishCached)
				for (const key of ["tokens", "requests"] as const) {
					if (j.usage[key] >= j.budget[key])
						throw new Error("RESUME_BUDGET_EXHAUSTED");
				}
			if (
				phase === "finalize" &&
				invalidReasons.includes(j.reason || "") &&
				j.reason !== "INVALID_QUALITY_REVIEW"
			)
				this.sql
					.query(
						"DELETE FROM records WHERE job_id=? AND kind='generation' AND id=?",
					)
					.run(id, `synthesis:${j.config.generationAttempt ?? 0}`);
			const previousStatus = j.status;
			if (j.config.engineVersion === 2)
				for (const item of this.workItems(id)) {
					if (item.status === "running") {
						item.status = "pending";
						this.saveWork(item);
					}
				}
			// A user-triggered resume authorizes retrying only unfinished calls.
			// Keep the original reservation and audit trail: its cost is uncertain.
			for (const operation of this.all<{ id: string; state: string }>(
				id,
				"operation",
			)) {
				const invalidResponse =
					(operation.id.startsWith("scope:") &&
						this.record<{ invalid: boolean }>(
							id,
							"scope_validation",
							operation.id,
						)?.invalid === true) ||
					(phase === "suggest" &&
						operation.id === "suggest" &&
						j.status !== "cancelled") ||
					(phase === "finalize" &&
						operation.id.startsWith("synthesis:") &&
						(j.reason !== "INVALID_QUALITY_REVIEW" ||
							operation.id.endsWith(":review")) &&
						[
							"ARTIFACT_CHANGED_DURING_GENERATION",
							"INVALID_REPORT_RESPONSE",
							"INVALID_QUALITY_REVIEW",
							"NARRATIVE_REQUIRED",
							"INVALID_CLAIM_REFERENCE",
							"INVALID_EVIDENCE_REFERENCE",
						].includes(j.reason || ""));
				if (operation.state === "done" && !invalidResponse) continue;
				this.event(id, "operation.retry_authorized", operation);
				this.sql
					.query(
						"DELETE FROM records WHERE job_id=? AND kind='operation' AND id=?",
					)
					.run(id, operation.id);
			}
			const remainingMs =
				(j.deadline ?? j.updatedAt + j.budget.wallMs) - j.updatedAt;
			if (remainingMs <= 0) throw new Error("RESUME_TIME_EXHAUSTED");
			j.deadline = Date.now() + remainingMs;
			j.status = j.startedAt ? "running" : "queued";
			j.reason = null;
			this.saveJob(j);
			this.sql
				.query(
					"UPDATE tasks SET state='pending',token='',lease_until=0,next_at=? WHERE id=?",
				)
				.run(Date.now(), task.id);
			this.event(id, "job.resumed", { previousStatus });
			return j;
		});
	}

	claim(leaseMs = 30000, jobId?: string): Task | null {
		return this.atomic(() => {
			const row = this.sql
				.query(
					"SELECT * FROM tasks WHERE (state='pending' OR (state='running' AND lease_until<?)) AND next_at<=? AND (? IS NULL OR job_id=?) ORDER BY next_at,rowid LIMIT 1",
				)
				.get(
					Date.now(),
					Date.now(),
					jobId ?? null,
					jobId ?? null,
				) as Task | null;
			if (!row) return null;
			const token = uid(),
				until = Date.now() + leaseMs;
			this.sql
				.query(
					"UPDATE tasks SET state='running',token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
				)
				.run(token, until, row.id);
			return {
				...row,
				state: "running",
				token,
				lease_until: until,
				attempts: row.attempts + 1,
			};
		});
	}
	assertLease(t: Task) {
		const r = this.sql
			.query(
				"SELECT id FROM tasks WHERE id=? AND token=? AND state='running' AND lease_until>?",
			)
			.get(t.id, t.token, Date.now());
		if (!r) throw new LeaseLost();
	}
	heartbeat(t: Task, ms = 30000) {
		return (
			this.sql
				.query(
					"UPDATE tasks SET lease_until=? WHERE id=? AND token=? AND state='running' AND lease_until>?",
				)
				.run(Date.now() + ms, t.id, t.token, Date.now()).changes === 1
		);
	}
	commit(t: Task, fn: () => void, payload: unknown, done = false, delay = 0) {
		this.atomic(() => {
			this.assertLease(t);
			fn();
			this.sql
				.query(
					"UPDATE tasks SET state=?,payload=?,lease_until=0,next_at=? WHERE id=? AND token=?",
				)
				.run(
					done ? "done" : "pending",
					JSON.stringify(payload),
					Date.now() + delay,
					t.id,
					t.token,
				);
		});
	}
	reserve(t: Task, amount: Partial<Usage>) {
		this.atomic(() => {
			this.assertLease(t);
			const j = this.getJob(t.job_id);
			if (!j) throw new Error("JOB_NOT_FOUND");
			if (
				j.status === "cancel_requested" ||
				(j.deadline !== null && Date.now() >= j.deadline)
			)
				throw new BudgetExceeded();
			for (const key of Object.keys(amount) as (keyof Usage)[]) {
				const n = amount[key] ?? 0;
				if (
					n < 0 ||
					!Number.isFinite(n) ||
					j.usage[key] + n > j.budget[key] + 1e-9
				)
					throw new BudgetExceeded();
			}
			for (const key of Object.keys(amount) as (keyof Usage)[])
				j.usage[key] += amount[key] ?? 0;
			this.saveJob(j);
			this.event(j.id, "budget.reserved", amount);
		});
	}
	queueMaintenance(jobId: string, kind: "review" | "edit") {
		return this.atomic(() => {
			const j = this.getJob(jobId);
			const detail = this.detail(jobId);
			const artifact = detail?.artifacts[0];
			if (!j || !artifact) throw new Error("ARTIFACT_REQUIRED");
			if (!terminal(j.status)) throw new Error("JOB_STILL_ACTIVE");
			if (this.slot().state === "blocked")
				throw new Error("EXTERNAL_STOP_CONFIRMATION_REQUIRED");
			if (
				Date.now() >= (j.deadline ?? 0) ||
				j.usage.requests >= j.budget.requests ||
				j.usage.tokens >= j.budget.tokens
			)
				throw new Error("RESUME_BUDGET_EXHAUSTED");
			j.config.maintenance = { previousStatus: j.status, kind };
			j.status = "running";
			this.saveJob(j);
			for (const item of this.workItems(jobId).filter(
				(i) => i.status === "pending" || i.status === "running",
			)) {
				item.status = "cancelled";
				this.saveWork(item);
			}
			const w: WorkItem = {
				id: uid(),
				jobId,
				roundId: "final",
				kind,
				status: "pending",
				priority: 100,
				reason: "User requested report maintenance",
				revision: 0,
				nextAt: 0,
				dependsOn: [],
				payload:
					kind === "review"
						? { artifact, reviewOnly: true }
						: {
								previousReport: artifact,
								feedback: detail?.qualityReviews?.find(
									(r) => r.version === artifact.version,
								)?.review,
							},
				createdAt: Date.now(),
			};
			this.saveWork(w);
			this.sql
				.query(
					"UPDATE tasks SET state='pending',payload=?,token='',lease_until=0,next_at=0 WHERE job_id=?",
				)
				.run(JSON.stringify({ phase: "round" }), jobId);
			this.event(jobId, "artifact.maintenance_queued", { kind, workId: w.id });
			return w;
		});
	}
	workItems(jobId: string): WorkItem[] {
		return (
			this.sql
				.query(
					"SELECT data FROM research_work_items WHERE job_id=? ORDER BY priority DESC,rowid",
				)
				.all(jobId) as { data: string }[]
		).map((r) => JSON.parse(r.data));
	}
	saveWork(item: WorkItem) {
		const existing = this.workItems(item.jobId);
		if (
			item.dependsOn.includes(item.id) ||
			item.dependsOn.some((id) => !existing.some((w) => w.id === id))
		)
			throw new Error("INVALID_WORK_DEPENDENCY");
		const reaches = (id: string, seen = new Set<string>()): boolean => {
			if (id === item.id) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return (
				existing
					.find((w) => w.id === id)
					?.dependsOn.some((dep) => reaches(dep, seen)) ?? false
			);
		};
		if (item.dependsOn.some((id) => reaches(id)))
			throw new Error("CYCLIC_WORK_DEPENDENCY");

		this.sql
			.query(
				"INSERT INTO research_work_items VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,priority=excluded.priority,next_at=excluded.next_at,revision=excluded.revision,data=excluded.data",
			)
			.run(
				item.id,
				item.jobId,
				item.roundId,
				item.kind,
				item.status,
				item.priority,
				item.nextAt,
				item.revision,
				JSON.stringify(item),
			);
	}
	research(jobId: string): ResearchState {
		const meta = this.record<{
			id: string;
			revision: number;
			sufficient: boolean | null;
			reason: string;
		}>(jobId, "research", "state");
		const slot = this.slot();
		return {
			version: 2,
			holds: this.all(jobId, "budget_hold"),
			revision: meta?.revision ?? 0,
			sufficient: meta?.sufficient ?? null,
			reason: meta?.reason ?? "",
			rounds: this.all<Round>(jobId, "round").sort(
				(a, b) => a.number - b.number,
			),
			items: this.workItems(jobId),
			candidates: this.all(jobId, "exploration_candidate"),
			slot: {
				state: slot.state,
				jobId: slot.job_id,
				operationKey: slot.operation_key,
			},
		};
	}
	reprioritize(jobId: string, id: string, revision: number, priority: number) {
		return this.atomic(() => {
			const item = this.workItems(jobId).find((i) => i.id === id);
			if (!item) throw new Error("NOT_FOUND");
			if (
				item.revision !== revision ||
				item.status !== "pending" ||
				terminal(this.getJob(jobId)?.status ?? "")
			)
				throw new Error("REVISION_CONFLICT");
			item.priority = priority;
			item.revision++;
			this.saveWork(item);
			this.event(jobId, "work.reprioritized", { id, priority });
			return item;
		});
	}
	addExploration(
		jobId: string,
		key: string,
		revision: number,
		question: string,
		purpose: "core" | "supplement" | "trivia",
	) {
		return this.atomic(() => {
			const j = this.getJob(jobId);
			if (!j) throw new Error("NOT_FOUND");
			const previous = this.record<{
				id: string;
				question: string;
				purpose: string;
			}>(jobId, "exploration_candidate", key);
			if (previous) {
				if (previous.question !== question || previous.purpose !== purpose)
					throw new Error("REVISION_CONFLICT");
				return previous;
			}
			const state = this.research(jobId);
			if (
				j.config.engineVersion !== 2 ||
				j.status === "finalizing" ||
				this.record<{ decisionLocked?: boolean }>(jobId, "research", "state")
					?.decisionLocked ||
				terminal(j.status) ||
				state.revision !== revision
			)
				throw new Error("REVISION_CONFLICT");
			if (state.candidates.length >= 50) throw new Error("CANDIDATE_LIMIT");
			const candidate = {
				id: key,
				question,
				purpose,
				status: "pending",
				revision: revision + 1,
			};
			this.put(jobId, "exploration_candidate", key, candidate);
			this.put(jobId, "research", "state", {
				id: "state",
				revision: revision + 1,
				sufficient: state.sufficient,
				reason: state.reason,
			});
			this.event(jobId, "exploration.added", candidate);
			return candidate;
		});
	}
	slot() {
		return this.sql.query("SELECT * FROM execution_slot WHERE id=1").get() as {
			owner_token: string;
			lease_until: number;
			job_id: string | null;
			operation_key: string | null;
			state: string;
		};
	}
	acquireSlot(t: Task) {
		return this.atomic(() => {
			this.assertLease(t);
			const s = this.slot();
			if (s.state === "blocked") return false;
			if (s.operation_key?.startsWith("pending:") && s.job_id !== t.job_id)
				return false;
			if (s.owner_token && s.owner_token !== t.token) {
				if (s.lease_until > Date.now()) return false;
				if (s.operation_key && !s.operation_key.startsWith("pending:")) {
					this.sql
						.query("UPDATE execution_slot SET state='blocked' WHERE id=1")
						.run();
					if (s.job_id && this.getJob(s.job_id))
						this.event(s.job_id, "operation.stop_confirmation_required", {
							operationKey: s.operation_key,
						});
					return false;
				}
			}
			this.sql
				.query(
					"UPDATE execution_slot SET owner_token=?,lease_until=?,job_id=?,state='active' WHERE id=1",
				)
				.run(t.token, Date.now() + 30000, t.job_id);
			return true;
		});
	}
	releaseSlot(t: Task) {
		this.sql
			.query(
				"UPDATE execution_slot SET owner_token='',lease_until=0 WHERE id=1 AND owner_token=? AND operation_key LIKE 'pending:%' AND state!='blocked'",
			)
			.run(t.token);
		this.sql
			.query(
				"UPDATE execution_slot SET owner_token='',lease_until=0,job_id=NULL,state='idle' WHERE id=1 AND owner_token=? AND operation_key IS NULL AND state!='blocked'",
			)
			.run(t.token);
	}
	markExternal(t: Task, key: string | null) {
		this.assertLease(t);
		if (this.slot().owner_token !== t.token) throw new LeaseLost();
		this.sql
			.query(
				"UPDATE execution_slot SET operation_key=? WHERE id=1 AND owner_token=?",
			)
			.run(key, t.token);
	}
	confirmDeletedExternalStopped(reason: string) {
		this.atomic(() => {
			const s = this.slot();
			if (s.state !== "blocked" || s.job_id !== null)
				throw new Error("NOT_BLOCKED");
			this.sql
				.query(
					"INSERT INTO execution_events(type,data,created_at) VALUES(?,?,?)",
				)
				.run(
					"deleted_operation_stop_confirmed",
					JSON.stringify({ operationKey: s.operation_key, reason }),
					Date.now(),
				);
			this.sql
				.query(
					"UPDATE execution_slot SET state='idle',owner_token='',lease_until=0,job_id=NULL,operation_key=NULL WHERE id=1",
				)
				.run();
		});
	}
	confirmExternalStopped(jobId: string, reason: string) {
		this.atomic(() => {
			const s = this.slot();
			if (s.job_id !== jobId || s.state !== "blocked")
				throw new Error("NOT_BLOCKED");
			this.event(jobId, "operation.stop_confirmed", {
				operationKey: s.operation_key,
				reason,
			});
			this.sql
				.query(
					"UPDATE execution_slot SET state='idle',owner_token='',lease_until=0,job_id=NULL,operation_key=NULL WHERE id=1",
				)
				.run();
		});
	}

	close() {
		this.sql.close();
	}
}
