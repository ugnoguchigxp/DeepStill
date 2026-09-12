import { useEffect, useState } from "react";
import type { JobDetail } from "../../../packages/contracts";
import { terminal } from "../../../packages/core";
export function researchProgress(detail: JobDetail) {
	const { job } = detail;
	if (terminal(job.status)) return null;
	const active = detail.operations.find(
		(value) =>
			!!value &&
			typeof value === "object" &&
			"state" in value &&
			value.state === "intent",
	) as { id: string; startedAt?: number } | undefined;
	let label =
		job.status === "queued"
			? "Workerの処理開始を待っています"
			: "次の探索を準備しています";
	let subject = "";
	if (job.status === "cancel_requested") label = "停止を反映しています";
	else if (active) {
		const id = active.id;
		if (id === "suggest") label = "LLMが探索する論点と検索語を考えています";
		else if (id.startsWith("synthesis"))
			label = "LLMが根拠を整理し、レポートを作成しています";
		else if (id.startsWith("llm:")) {
			label = "LLMが取得した資料を読み、根拠を抽出しています";
			subject = detail.sources.find((s) => s.id === id.slice(4))?.title || "";
		} else if (id.startsWith("crawl:")) {
			label = "Webページの本文を取得しています";
			subject = id.slice(6).replace(/:\d+$/, "");
		} else if (id.startsWith("poll:") || id.startsWith("submit:")) {
			label = id.startsWith("poll:")
				? "Web検索の結果を待っています"
				: "検索を依頼しています";
			subject =
				detail.queries.find((q) => q.id === id.split(":")[1])?.query || "";
		}
	}
	const reservation = [...detail.events]
		.reverse()
		.find((e) => e.type === "budget.reserved");
	return {
		label,
		subject,
		since: active
			? (active.startedAt ?? reservation?.createdAt ?? job.updatedAt)
			: job.updatedAt,
		queued: job.status === "queued",
	};
}
export function ResearchProgress({
	detail,
	unavailable = false,
}: {
	detail: JobDetail;
	unavailable?: boolean;
}) {
	const [now, setNow] = useState(Date.now());
	const progress = researchProgress(detail);
	const running = progress !== null;
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	if (!progress) return null;
	const seconds = Math.max(0, Math.floor((now - progress.since) / 1000));
	return (
		<section
			className="research-progress"
			aria-label="調査の進行状況"
			aria-busy={!unavailable}
		>
			<div role="status" aria-live="polite">
				<span
					className={unavailable ? "" : "loading-spinner"}
					aria-hidden="true"
				/>
				<strong>
					{unavailable
						? "進捗を取得できません。サーバーとの接続を確認しています"
						: progress.label}
				</strong>
			</div>
			{progress.subject && (
				<p className="progress-subject">{progress.subject}</p>
			)}
			<small>
				この処理の待ち時間：{seconds}秒 · 取得済み {detail.sources.length}資料 ·
				根拠付き知見 {detail.claims.filter((c) => c.accepted).length}件
			</small>
			{(unavailable || seconds > 180 || (progress.queued && seconds > 15)) && (
				<p className="progress-delay">
					更新が届いていません。APIとWorkerが起動しているか、「実行履歴」を確認してください。
				</p>
			)}
			{!unavailable && seconds >= 30 && seconds <= 180 && !progress.queued && (
				<p>
					検索・LLM処理は数十秒〜数分かかることがあります。結果が届くと表示を更新します。
				</p>
			)}
		</section>
	);
}
