import {
	QueryClient,
	QueryClientProvider,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Job, JobDetail } from "../../../packages/contracts";
import { DeleteResearchDialog } from "./delete-research-dialog";
import { ResearchProgress } from "./research-progress";
import {
	RoundProgress,
	researchReason,
	DeletedExecutionRecovery,
} from "./round-progress";
import "./style.css";

const client = new QueryClient();
async function api<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(`/api${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await r.json();
	if (!r.ok) throw new Error(data.error || "通信に失敗しました");
	return data;
}
const statusLabel: Record<string, string> = {
	queued: "待機中",
	running: "探索中",
	finalizing: "レポート生成中",
	completed: "完了",
	partial: "部分成果",
	failed: "失敗",
	cancel_requested: "停止処理中",
	cancelled: "停止済み",
};
function Status({ job }: { job: Job }) {
	return (
		<span className={`status ${job.status}`}>
			<i />
			{statusLabel[job.status]}
		</span>
	);
}
function App() {
	const cache = useQueryClient();
	const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
	const [selected, setSelected] = useState<string | null>(() =>
		new URLSearchParams(location.search).get("job"),
	);
	const [topic, setTopic] = useState("");
	const [mode, setMode] = useState<"mock" | "live">("live");
	const [strategy, setStrategy] = useState("balanced");
	const [tab, setTab] = useState("artifact");
	const [evidenceId, setEvidenceId] = useState<string | null>(null);
	const [budget, setBudget] = useState({
		rounds: 6,
		queries: 50,
		urls: 100,
		tokens: 1000000,
		wallMs: 7200000,
		documents: 20,
		requests: 200,
		depth: 5,
		costUsd: 5,
	});
	const config = useQuery({
		queryKey: ["config"],
		queryFn: () =>
			api<{
				liveReady: boolean;
				executionBlocked?: boolean;
				worker?: { ready: boolean; stale: boolean };
				codex?: { ready: boolean; error: string | null };
				contextConnected: boolean;
				llmProvider: string;
				model: string;
				reasoning: string;
				searchProvider: string;
			}>("/config"),
		refetchInterval: 2000,
	});
	const jobs = useQuery({
		queryKey: ["jobs"],
		queryFn: () => api<Job[]>("/jobs"),
		refetchInterval: 2000,
	});
	const detail = useQuery({
		queryKey: ["job", selected],
		queryFn: () => api<JobDetail>(`/jobs/${selected}`),
		enabled: !!selected,
		refetchInterval: 2000,
	});
	const choose = (id: string) => {
		setSelected(id);
		setEvidenceId(null);
		history.replaceState(null, "", `?job=${id}`);
	};
	const create = useMutation({
		mutationFn: () => api<Job>("/jobs", { topic, mode, strategy, budget }),
		onSuccess: (j) => {
			choose(j.id);
			setTopic("");
			cache.invalidateQueries({ queryKey: ["jobs"] });
		},
	});
	const remove = useMutation({
		mutationFn: (id: string) => api(`/jobs/${id}/delete`, { confirmed: true }),
		onSuccess: async (_, id) => {
			await cache.cancelQueries({ queryKey: ["jobs"] });
			await cache.cancelQueries({ queryKey: ["job", id] });
			cache.setQueryData<Job[]>(["jobs"], (items) =>
				items?.filter((item) => item.id !== id),
			);
			if (selected === id) {
				setSelected(null);
				setEvidenceId(null);
				history.replaceState(null, "", location.pathname);
			}
			cache.removeQueries({ queryKey: ["job", id] });
			setDeleteTarget(null);
			cache.invalidateQueries({ queryKey: ["jobs"] });
		},
	});

	const restart = useMutation({
		mutationFn: (researchTopic: string) =>
			api<Job>("/jobs", {
				topic: researchTopic,
				mode: "live",
				strategy,
				budget,
			}),
		onSuccess: (job) => {
			choose(job.id);
			setTab("artifact");
			cache.invalidateQueries({ queryKey: ["jobs"] });
		},
	});
	const resume = useMutation({
		mutationFn: () => api(`/jobs/${selected}/resume`, {}),
		onSuccess: () => cache.invalidateQueries(),
	});

	const cancel = useMutation({
		mutationFn: () => api(`/jobs/${selected}/cancel`, {}),
		onSuccess: () => cache.invalidateQueries(),
	});
	useEffect(() => {
		if (!selected) return;
		const events = new EventSource(`/api/jobs/${selected}/events`);
		events.addEventListener("update", (message) => {
			const event = JSON.parse((message as MessageEvent).data);
			if (
				[
					"job.completed",
					"job.partial",
					"job.failed",
					"job.cancelled",
				].includes(event.type)
			)
				events.close();
			cache.invalidateQueries({ queryKey: ["job", selected] });
			cache.invalidateQueries({ queryKey: ["jobs"] });
		});
		return () => events.close();
	}, [selected, cache]);
	useEffect(() => {
		if (!evidenceId) return;
		const previous = document.activeElement as HTMLElement | null;
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		if (!dialog) return;
		dialog.focus();
		const outside = (event: Event) => {
			if (event.target instanceof Node && !dialog.contains(event.target)) {
				setEvidenceId(null);
			}
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setEvidenceId(null);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", key);
			if (
				document.activeElement === document.body ||
				dialog.contains(document.activeElement)
			) {
				previous?.focus();
			}
		};
	}, [evidenceId]);
	const d = detail.data,
		j = d?.job;
	const evidence = d?.evidence.find((e) => e.id === evidenceId);
	const source = d?.sources.find((s) => s.id === evidence?.snapshotId);
	return (
		<div className="shell">
			<aside className="sidebar">
				<a className="brand" href="/">
					◈{" "}
					<span>
						DeepStill<small>RESEARCH WORKSPACE</small>
					</span>
				</a>
				<div className="sidebar-label history-label">
					RECENT RESEARCH <span>{jobs.data?.length ?? 0}</span>
				</div>
				<nav aria-label="調査一覧">
					{jobs.data?.map((job) => (
						<div className="job-row" key={job.id}>
							<button
								type="button"
								className={`job-link ${selected === job.id ? "selected" : ""}`}
								onClick={() => choose(job.id)}
							>
								<span>{job.topic}</span>
								<small>
									{statusLabel[job.status]} ·{" "}
									{job.mode === "mock" ? "検証" : "Web"}
								</small>
							</button>
							<button
								type="button"
								className="job-delete"
								aria-label={`${job.topic}を削除`}
								title="調査を削除"
								onClick={() => {
									remove.reset();
									setDeleteTarget(job);
								}}
							>
								×
							</button>
						</div>
					))}
				</nav>
				<div className="sidebar-foot">
					<span className="connected-dot" /> ローカルワークスペース
					<small>Compile once, read many.</small>
				</div>
			</aside>
			<main>
				{config.data?.executionBlocked && <DeletedExecutionRecovery />}
				<div className="content">
					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault();
							create.mutate();
						}}
					>
						<label htmlFor="topic">調べたいテーマ</label>
						<div className="input-row">
							<input
								id="topic"
								value={topic}
								onChange={(e) => setTopic(e.target.value)}
								placeholder="例：ローカルLLMのKV cache routing"
								minLength={2}
								maxLength={400}
								required
							/>
							<button
								className="primary"
								type="submit"
								disabled={
									create.isPending ||
									(mode === "live" && !config.data?.liveReady)
								}
							>
								{create.isPending && (
									<span className="loading-spinner" aria-hidden="true" />
								)}
								{create.isPending
									? "調査を開始しています…"
									: mode === "mock"
										? "固定サンプルで動作確認"
										: "調査をはじめる"}{" "}
								<span aria-hidden="true">↗</span>
							</button>
						</div>
						<div className="settings">
							<label>
								実行モード
								<select
									aria-label="実行モード"
									value={mode}
									onChange={(e) => setMode(e.target.value as "mock" | "live")}
								>
									<option value="mock">検証デモ（外部通信なし）</option>
									<option value="live" disabled={!config.data?.liveReady}>
										Web調査{!config.data?.liveReady ? "（接続設定が必要）" : ""}
									</option>
								</select>
								<small>
									接続:{" "}
									{config.data?.llmProvider === "codex"
										? `Codex SDK · ${config.data.model} · reasoning ${config.data.reasoning}`
										: "互換LLM API"}{" "}
									/ 検索:{" "}
									{config.data?.searchProvider === "codex"
										? "Codex Web"
										: "DataForSEO"}
								</small>
							</label>
							<label>
								探索戦略
								<select
									value={strategy}
									onChange={(e) => setStrategy(e.target.value)}
								>
									<option value="balanced">関連性を優先</option>
									<option value="diverse">情報源の多様性を優先</option>
								</select>
							</label>
							<details>
								<summary>予算を設定</summary>
								<div className="budget-fields">
									{(
										[
											["queries", "Query上限"],
											["urls", "URL上限"],
											["tokens", "Token上限"],
											["wallMs", "時間上限（分）"],
											["documents", "解析文書上限"],
											["requests", "リクエスト上限"],
											["depth", "探索の深さ"],
											["rounds", "ラウンド上限"],
											["costUsd", "検索費用上限（USD）"],
										] as const
									).map(([key, label]) => (
										<label key={key}>
											{label}
											<input
												type="number"
												step={key === "costUsd" ? 0.01 : 1}
												value={
													key === "wallMs" ? budget[key] / 60000 : budget[key]
												}
												min={
													key === "tokens"
														? 4096
														: key === "depth"
															? 0
															: key === "costUsd"
																? 0.01
																: 1
												}
												onChange={(e) =>
													setBudget({
														...budget,
														[key]:
															Number(e.target.value) *
															(key === "wallMs" ? 60000 : 1),
													})
												}
											/>
										</label>
									))}
								</div>
							</details>
						</div>
						{mode === "mock" && (
							<p className="notice">
								動作確認用です。入力したテーマの調査は行わず、固定のサンプル本文を表示します。
							</p>
						)}
						{create.error && (
							<p role="alert" className="error">
								{create.error.message}
							</p>
						)}
					</form>
					{(jobs.error || detail.error) && (
						<p role="alert" className="error">
							データの取得に失敗しました。APIの起動を確認してください。
						</p>
					)}
					{!j ? (
						<section className="empty">
							<div className="empty-symbol">◎</div>
							<h2>最初の問いから、始めましょう。</h2>
							<p>
								テーマを入力すると、探索状況・知見・根拠がここに集まります。
							</p>
							<div className="steps">
								<span>
									01 <b>探索する</b>
								</span>
								<span>
									02 <b>根拠を確かめる</b>
								</span>
								<span>
									03 <b>知識として残す</b>
								</span>
							</div>
						</section>
					) : (
						<>
							<section className="research-heading">
								<div>
									<div className="eyebrow">RESEARCH / {j.id.slice(0, 8)}</div>
									<h2>{j.topic}</h2>
									<p>
										{new Date(j.createdAt).toLocaleString("ja-JP")} ·{" "}
										{j.strategy} ·{" "}
										{j.mode === "mock" ? "検証fixture" : "Web調査"}
									</p>
								</div>
								<div className="actions">
									<Status job={j} />
									{["cancelled", "failed", "partial"].includes(j.status) && (
										<button
											type="button"
											className="secondary"
											disabled={
												resume.isPending ||
												(j.mode === "live" && !config.data?.liveReady)
											}
											onClick={() => resume.mutate()}
										>
											{resume.isPending ? "再開しています…" : "探索を再開"}
										</button>
									)}
									{!["completed", "partial", "failed", "cancelled"].includes(
										j.status,
									) && (
										<button
											type="button"
											className="secondary"
											onClick={() => cancel.mutate()}
											disabled={
												cancel.isPending || j.status === "cancel_requested"
											}
										>
											{j.status === "cancel_requested"
												? "中止処理中…"
												: "探索を中止"}
										</button>
									)}
								</div>
							</section>
							{j.mode === "mock" && (
								<div className="notice demo-notice" role="note">
									<strong>これは固定サンプルによる動作確認です。</strong>
									<p>
										このテーマのWeb検索・LLM推論は実行していません。表示される英文は取得資料ではありません。
									</p>
									<button
										type="button"
										className="secondary"
										disabled={!config.data?.liveReady || restart.isPending}
										onClick={() => restart.mutate(j.topic)}
									>
										{restart.isPending
											? "Web調査を開始しています…"
											: "このテーマでWeb調査を開始"}
									</button>
								</div>
							)}
							{config.data?.worker && !config.data.worker.ready && (
								<p role="alert" className="notice">
									{config.data.worker.stale
										? "Workerが古いコードで動作しています。開発サーバーを再起動してください。"
										: "Workerが起動していないため探索できません。bun run dev で起動してください。"}
								</p>
							)}
							{config.data?.codex && !config.data.codex.ready && (
								<p role="alert" className="error">
									Codex
									CLIを利用できません。新しいCLIをインストールするか、CODEX_PATHで指定してください。
								</p>
							)}
							{d && (
								<>
									<RoundProgress detail={d} />
									{!d.research && (
										<ResearchProgress
											detail={d}
											unavailable={
												detail.isError || config.data?.worker?.ready === false
											}
										/>
									)}
								</>
							)}
							{j.reason && (
								<div className="notice">
									終了理由: {researchReason(j.reason)}
								</div>
							)}
							{["cancelled", "failed", "partial"].includes(j.status) && (
								<p className="notice">
									再開すると取得済み資料と使用量を引き継ぎ、残り予算で続行します。結果が不明な通信は再送され、追加の使用量が発生する場合があります。
								</p>
							)}
							{resume.error && (
								<p role="alert" className="error">
									再開できませんでした。中止の完了、残り予算・制限時間、APIの接続を確認してください。
								</p>
							)}
							{restart.error && (
								<p role="alert" className="error">
									Web調査を開始できませんでした。接続設定とAPIを確認してください。
								</p>
							)}
							{cancel.error && (
								<p role="alert" className="error">
									停止要求に失敗しました。再試行してください。
								</p>
							)}
							<div className="metrics">
								{(
									[
										["queries", "検索Query"],
										["urls", "取得URL"],
										["tokens", "LLM tokens"],
									] as const
								).map(([key, label]) => (
									<div className="metric" key={key}>
										<span>{label}</span>
										<strong>
											{Math.round(j.usage[key]).toLocaleString()}
											<small> / {j.budget[key].toLocaleString()}</small>
										</strong>
										<progress value={j.usage[key]} max={j.budget[key]} />
									</div>
								))}
								<div className="metric">
									<span>根拠付き知見</span>
									<strong>
										{d?.claims.filter((c) => c.accepted).length ?? 0}
										<small> findings</small>
									</strong>
									<p>
										{d?.sources.length ?? 0} sources / $
										{j.usage.costUsd.toFixed(4)}
									</p>
								</div>
							</div>
							<div className="tabs" role="tablist" aria-label="調査の表示">
								{[
									["artifact", "レポート"],
									["frontier", "探索経路"],
									["findings", "知見と根拠"],
									["activity", "実行履歴"],
								].map(([id, label]) => (
									<button
										type="button"
										role="tab"
										aria-selected={tab === id}
										key={id}
										onClick={() => setTab(id)}
									>
										{label}
										{id === "findings" && <small>{d?.claims.length}</small>}
									</button>
								))}
							</div>
							<section className="panel" role="tabpanel">
								{tab === "artifact" &&
									(d?.artifacts.length ? (
										<>
											<div className="panel-heading">
												<h3>Research Artifact</h3>
												<a href={`/api/jobs/${j.id}/report`}>
													レポートを保存 ↓
												</a>
												<a
													href={`/api/jobs/${j.id}/candidates`}
													target="_blank"
													rel="noreferrer"
												>
													候補JSONを開く ↗
												</a>
											</div>
											{j.mode === "mock" && (
												<div className="notice">
													これは動作検証用の固定資料です。実際のWeb調査結果ではありません。
												</div>
											)}
											{d.qualityReviews?.find(
												(r) => r.version === d.artifacts[0].version,
											)?.review.verdict === "pass" && (
												<div className="notice">
													品質レビュー：自動評価を通過。人間による確認は未実施です。研究範囲の限界は本文に記載しています。
												</div>
											)}
											{(d.artifacts[0].qualityState === "needs_revision" ||
												d.qualityReviews?.find(
													(r) => r.version === d.artifacts[0].version,
												)?.review.verdict === "revise") && (
												<div className="notice">
													品質レビュー：要改稿。資料や説明に不足があり、品質基準を満たしていません。
												</div>
											)}
											{d.artifacts[0].sections?.map((section, index) => (
												<section key={section.title} className="report-section">
													<h3>
														{index + 1}. {section.title}
													</h3>
													{section.paragraphs.map((paragraph) => (
														<div
															key={paragraph.text}
															className="claim-paragraph"
														>
															<p>{paragraph.text}</p>
															{paragraph.claimIds.map((id) => {
																const claim = d.claims.find((c) => c.id === id);
																return (
																	claim && (
																		<button
																			type="button"
																			className="citation"
																			key={id}
																			onClick={() =>
																				setEvidenceId(claim.evidenceIds[0])
																			}
																		>
																			[{d.artifacts[0].claimIds.indexOf(id) + 1}
																			] 根拠を確認 ↗
																		</button>
																	)
																);
															})}
														</div>
													))}
												</section>
											))}
											{d.artifacts[0].limitations?.length ? (
												<section>
													<h3>この調査の限界</h3>
													<ul>
														{d.artifacts[0].limitations.map((text) => (
															<li key={text}>{text}</li>
														))}
													</ul>
												</section>
											) : null}
											{d.artifacts[0].openQuestions?.length ? (
												<section>
													<h3>残された問い</h3>
													<ul>
														{d.artifacts[0].openQuestions.map((text) => (
															<li key={text}>{text}</li>
														))}
													</ul>
												</section>
											) : null}
											{!d.artifacts[0].sections &&
												d.artifacts[0].claimIds.map((id, i) => {
													const c = d.claims.find((c) => c.id === id);
													return c ? (
														<div className="claim-paragraph" key={id}>
															<p>{c.text}</p>
															<button
																type="button"
																className="citation"
																onClick={() => setEvidenceId(c.evidenceIds[0])}
															>
																[{i + 1}] 根拠を確認 ↗
															</button>
														</div>
													) : null;
												})}
											<footer className="report-footer">
												Version {d.artifacts[0].version} ·{" "}
												{new Date(d.artifacts[0].generatedAt).toLocaleString(
													"ja-JP",
												)}
												<p>
													引用位置の一致を検証済み。内容の妥当性は原典と合わせて確認してください。
												</p>
											</footer>
										</>
									) : (
										<div className="waiting">
											<div>◌</div>
											<h3>
												{["partial", "failed", "cancelled"].includes(j.status)
													? "レポートは生成されていません"
													: "根拠を集めています"}
											</h3>
											<p>
												収集済みの情報は「知見と根拠」「実行履歴」で確認できます。
											</p>
										</div>
									))}
								{tab === "frontier" && (
									<>
										<h3>Query Frontier</h3>
										<div className="table-wrap">
											<table>
												<thead>
													<tr>
														<th>Query</th>
														<th>Score / Depth</th>
														<th>状態</th>
														<th>選択理由</th>
													</tr>
												</thead>
												<tbody>
													{d?.queries.map((q) => (
														<tr key={q.id}>
															<td>
																{q.query}
																<small>
																	{d.edges
																		.filter((e) => e.to === q.id)
																		.map(
																			(e) =>
																				`${d.queries.find((q) => q.id === e.from)?.query} → ${e.source}`,
																		)
																		.join(" / ")}
																</small>
															</td>
															<td>
																{q.score} / {q.depth}
															</td>
															<td>{q.status}</td>
															<td>{q.reason}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</>
								)}
								{tab === "findings" && (
									<>
										<h3>
											Findings <small>{d?.claims.length ?? 0}</small>
										</h3>
										{!d?.claims.length && (
											<p className="muted">検証済みのClaimはまだありません。</p>
										)}
										{d?.claims.map((c) => (
											<div className="finding" key={c.id}>
												<div>
													<span className={`kind ${c.kind}`}>{c.kind}</span>
													<span className="muted">
														confidence {c.confidence.toFixed(2)}
													</span>
												</div>
												<p>{c.text}</p>
												<small>{c.reason}</small>
												<button
													type="button"
													className="citation"
													onClick={() => setEvidenceId(c.evidenceIds[0])}
												>
													Evidenceを開く ↗
												</button>
											</div>
										))}
									</>
								)}
								{tab === "activity" && (
									<>
										<h3>Activity log</h3>
										{d?.events.map((e) => (
											<div className="event" key={e.id}>
												<time>
													{new Date(e.createdAt).toLocaleTimeString("ja-JP")}
												</time>
												<div>
													<strong>{e.type}</strong>
													<pre>{JSON.stringify(e.data)}</pre>
												</div>
											</div>
										))}
									</>
								)}
							</section>
						</>
					)}
					<footer className="page-footer">
						DeepStill <span>すべての知見に、辿れる根拠を。</span>
					</footer>
				</div>
			</main>
			{deleteTarget && (
				<DeleteResearchDialog
					topic={deleteTarget.topic}
					pending={remove.isPending}
					error={
						remove.error ? "削除に失敗しました。もう一度お試しください。" : null
					}
					onCancel={() => setDeleteTarget(null)}
					onDelete={() => remove.mutate(deleteTarget.id)}
				/>
			)}

			{evidence && source && (
				<div className="drawer-backdrop">
					<section
						className="drawer"
						role="dialog"
						tabIndex={-1}
						aria-label="Evidence詳細"
					>
						<div className="eyebrow">SOURCE EVIDENCE</div>
						<h2>{source.title}</h2>
						<a href={source.finalUrl} target="_blank" rel="noreferrer">
							原典を開く ↗
						</a>
						<blockquote>{evidence.quote}</blockquote>
						<dl>
							<dt>取得日時</dt>
							<dd>{source.fetchedAt}</dd>
							<dt>引用位置（UTF-16）</dt>
							<dd>
								[{evidence.start}, {evidence.end})
							</dd>
							<dt>Snapshot hash</dt>
							<dd className="hash">{source.hash}</dd>
							<dt>抽出方式</dt>
							<dd>
								{source.extractor} / {source.fetchMethod}
							</dd>
						</dl>
						{source.truncated && (
							<p className="notice">本文は取得上限で切れています。</p>
						)}
						<h3>前後の文脈</h3>
						<pre className="source-text">{evidence.context}</pre>
						<details>
							<summary>取得時の本文を表示</summary>
							<pre className="source-text">{source.text}</pre>
						</details>
					</section>
				</div>
			)}
		</div>
	);
}
const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<React.StrictMode>
			<QueryClientProvider client={client}>
				<App />
			</QueryClientProvider>
		</React.StrictMode>,
	);
