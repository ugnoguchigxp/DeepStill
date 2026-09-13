import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { JobDetail } from "../../../packages/contracts";
import { terminal } from "../../../packages/core";

const kinds: Record<string, string> = {
	prepare_brief: "回答項目を整理",
	lookup_knowledge: "既存の知識を確認",
	search_submit: "検索を依頼",
	search_poll: "検索結果を待機",
	select_sources: "読む資料を選出",
	fetch: "資料を取得",
	read: "資料を読解",
	check_claims: "主張と根拠を照合",
	compress_claims: "評価用の情報を整理",
	evaluate: "十分性と追加価値を評価",
	synthesize: "回答を統合",
	review: "回答を検証",
	edit: "回答を改善",
};
export function RoundProgress({ detail }: { detail: JobDetail }) {
	const cache = useQueryClient();
	const [stopReason, setStopReason] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [question, setQuestion] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const state = detail.research;
	if (!state) return null;
	const round = state.rounds.at(-1);
	const active = state.items.find((i) => i.status === "running");
	const pending = state.items.filter((i) => i.status === "pending");
	const reads = state.items.filter(
		(i) => i.roundId === round?.id && i.kind === "read",
	);
	async function send(path: string, body: unknown, method = "POST") {
		setBusy(true);
		setMessage("");
		try {
			const r = await fetch(`/api/jobs/${detail.job.id}/${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!r.ok)
				throw new Error(
					r.status === 409
						? "状態が更新されました。最新の表示で再度操作してください。"
						: "更新できませんでした。",
				);
			setMessage("変更を保存しました。");
			await cache.invalidateQueries({ queryKey: ["job", detail.job.id] });
			return true;
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "更新に失敗しました。");
			return false;
		} finally {
			setBusy(false);
		}
	}
	return (
		<section
			className="research-progress"
			aria-label="ラウンド探索"
			aria-busy={
				!terminal(detail.job.status) && state.slot?.state !== "blocked"
			}
		>
			<h3>
				{!terminal(detail.job.status) && state.slot?.state !== "blocked" && (
					<span className="loading-spinner" aria-hidden="true" />
				)}
				ラウンド {round?.number ?? 0} / {detail.job.budget.rounds}
			</h3>
			<p>
				{state.sufficient === true
					? "回答に必要な根拠は揃っています"
					: state.sufficient === false
						? "回答に不足する情報があります"
						: "回答の十分性は未評価です"}
			</p>
			{round && (
				<p>
					{round.purpose === "core"
						? "中心の問いを調査"
						: round.purpose === "trivia"
							? "トリビアを調査"
							: "補足を調査"}{" "}
					· 読解処理 {reads.filter((i) => i.status === "succeeded").length} /{" "}
					{reads.length}件
				</p>
			)}
			{active && <p>現在：{kinds[active.kind] ?? active.kind}</p>}
			{state.reason && <p>{researchReason(state.reason)}</p>}
			{state.holds?.some((h) => h.state === "held") && (
				<p>
					評価・回答作成のために残している予算：
					{state.holds
						.filter((h) => h.state === "held")
						.reduce((n, h) => n + h.tokens, 0)
						.toLocaleString()}{" "}
					tokens
				</p>
			)}
			{state.slot?.state === "blocked" &&
				state.slot.jobId === detail.job.id && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void send("confirm-external-stopped", {
								confirmed,
								reason: stopReason,
							});
						}}
					>
						<label>
							<input
								type="checkbox"
								checked={confirmed}
								onChange={(e) => setConfirmed(e.target.checked)}
								required
							/>
							外部サービス側で処理が終了したことを確認しました
						</label>
						<label>
							確認した内容
							<input
								value={stopReason}
								onChange={(e) => setStopReason(e.target.value)}
								minLength={5}
								maxLength={400}
								required
							/>
						</label>
						<button type="submit" disabled={busy || !confirmed}>
							終了確認を記録
						</button>
					</form>
				)}

			{state.slot?.state === "blocked" && (
				<p role="alert">
					外部処理の終了を確認できないため、新しい処理を停止しています。終了を確認してから再開してください。
				</p>
			)}
			{round?.evaluation && (
				<details>
					<summary>評価の根拠</summary>
					<ul>
						{round.evaluation.coverage.map((c) => (
							<li key={c.requirementId}>
								{
									{
										sufficient: "十分",
										partial: "一部不足",
										missing: "未確認",
									}[c.status]
								}
								：{c.reason}
							</li>
						))}
					</ul>
					<p>{round.evaluation.reason}</p>
				</details>
			)}
			{!terminal(detail.job.status) && detail.job.status !== "finalizing" && (
				<>
					<details>
						<summary>待機中の処理 {pending.length}件</summary>
						<ul>
							{pending.map((i) => (
								<li key={i.id}>
									{kinds[i.kind] ?? i.kind}：
									{String(i.payload.query ?? i.payload.title ?? "")}{" "}
									<button
										type="button"
										disabled={busy}
										onClick={() =>
											void send(
												`work-items/${i.id}`,
												{ expectedRevision: i.revision, priority: 100 },
												"PATCH",
											)
										}
									>
										優先する
									</button>
								</li>
							))}
						</ul>
					</details>
					<form
						onSubmit={async (e) => {
							e.preventDefault();
							const saved = await send("exploration-candidates", {
								expectedRevision: state.revision,
								idempotencyKey: crypto.randomUUID(),
								question,
								purpose: "supplement",
							});
							if (saved) setQuestion("");
						}}
					>
						<label>
							次のラウンドで評価する補足候補
							<input
								value={question}
								onChange={(e) => setQuestion(e.target.value)}
								minLength={2}
								maxLength={400}
								required
							/>
						</label>
						<button disabled={busy} type="submit">
							候補を追加
						</button>
					</form>
				</>
			)}
			{message && <p role="status">{message}</p>}
		</section>
	);
}

export function researchReason(reason: string) {
	const delivery: Record<string, string> = {
		saved_evidence_only: "保存済み資料での生成テストを終了",
		retrieval_recovery_limit: "取得失敗後の再探索上限に達したため停止",
		retrieval_blocked: "資料の取得が続けて失敗したため停止",
		token_budget: "残りのトークン予算では続行できないため停止",
		source_budget: "資料取得の予算に到達",
		query_budget: "検索回数の上限に到達",
		no_useful_link: "未確認事項に進む取得候補がないため停止",
		no_new_understanding: "新しい理解が増えなかったため停止",
		unresolved_questions: "未解決の問いを残して終了",
		repeated_search: "同じ検索の反復を防ぐため停止",
		invalid_deliverable: "引用または成果物形式の検証に失敗",
		search_timeout: "検索応答の待機上限に到達",
	};
	if (delivery[reason]) return delivery[reason];
	return (
		(
			{
				no_valuable_candidate:
					"追加で調べる価値のある候補がないため、回答をまとめました。",
				round_budget:
					"ラウンド上限に達したため、取得済みの根拠から回答をまとめました。",
				budget_exhausted:
					"探索予算の範囲で取得した根拠から回答をまとめました。",
				exploration_time_budget:
					"探索時間の上限に達したため、回答の作成に進みました。",
				generation_budget_exhausted:
					"回答作成の予算が不足したため、確認済みの根拠を保存しました。",
				time_budget: "時間の上限に達しました。",
				external_result_unknown:
					"外部処理の結果を確認できないため停止しています。",
				no_verified_claims: "回答に使える根拠を確認できませんでした。",
			} as Record<string, string>
		)[reason] ?? reason
	);
}

export function DeletedExecutionRecovery() {
	const cache = useQueryClient();
	const [reason, setReason] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	return (
		<section className="notice" aria-label="削除済み調査の処理確認">
			<p>
				削除した調査の外部処理が終了したか確認できないため、次の調査を待機しています。
			</p>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					try {
						const r = await fetch("/api/execution/confirm-stopped", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ confirmed, reason }),
						});
						if (!r.ok) throw new Error("確認を保存できませんでした。");
						await cache.invalidateQueries();
					} catch (e) {
						setMessage(
							e instanceof Error ? e.message : "保存できませんでした。",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				<label>
					<input
						type="checkbox"
						checked={confirmed}
						onChange={(e) => setConfirmed(e.target.checked)}
						required
					/>
					外部サービス側の処理終了を確認しました
				</label>
				<label>
					確認内容
					<input
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						minLength={5}
						maxLength={400}
						required
					/>
				</label>
				<button type="submit" disabled={!confirmed || busy}>
					終了確認を記録
				</button>
			</form>
			{message && <p role="status">{message}</p>}
		</section>
	);
}
