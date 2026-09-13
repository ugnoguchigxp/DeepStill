import type { ReactNode } from "react";
import type { JobDetail } from "../../../packages/contracts";
import type {
	MemoryEpisode,
	MemoryKnowledge,
} from "../../../packages/memory/schema";

function Items({
	items,
	ordered = false,
}: {
	items: string[];
	ordered?: boolean;
}) {
	const List = ordered ? "ol" : "ul";
	return items.length ? (
		<List>
			{[...new Set(items)].map((item) => (
				<li key={item}>{item}</li>
			))}
		</List>
	) : (
		<p className="memory-empty">記載なし</p>
	);
}
function Field({
	title,
	children,
	accent = false,
}: {
	title: string;
	children: ReactNode;
	accent?: boolean;
}) {
	return (
		<section className={`memory-field${accent ? " memory-highlight" : ""}`}>
			<h5>{title}</h5>
			{children}
		</section>
	);
}
function Disclosure({
	title,
	count,
	hint,
	children,
	warning = false,
}: {
	title: string;
	count: number;
	hint: string;
	children: ReactNode;
	warning?: boolean;
}) {
	return (
		<details className={`memory-disclosure${warning ? " memory-warning" : ""}`}>
			<summary>
				<span className="memory-disclosure-title">
					{title}
					<span className="memory-count">{count}件</span>
				</span>
				<span className="memory-hint">{hint}</span>
			</summary>
			<div className="memory-disclosure-body">{children}</div>
		</details>
	);
}
function Evidence({
	detail,
	claimIds,
	eventIds = [],
}: {
	detail: JobDetail;
	claimIds: string[];
	eventIds?: number[];
}) {
	const memory = detail.memory?.[0];
	const evidence = new Map<
		string,
		{ url: string; title: string; quote: string }
	>();
	for (const ref of memory?.evidence ?? []) {
		if (claimIds.includes(ref.claimId))
			evidence.set(ref.evidenceId, {
				url: ref.url,
				title:
					detail.sources.find((s) => s.id === ref.snapshotId)?.title || ref.url,
				quote: ref.quote,
			});
	}
	for (const claim of detail.claims.filter((c) => claimIds.includes(c.id))) {
		for (const id of claim.evidenceIds) {
			const e = detail.evidence.find((e) => e.id === id);
			const s = detail.sources.find((s) => s.id === e?.snapshotId);
			if (e && s)
				evidence.set(id, {
					url: s.finalUrl,
					title: s.title || s.finalUrl,
					quote: e.quote,
				});
		}
	}
	const events = [
		...new Map(
			[...(memory?.events ?? []), ...detail.events]
				.filter((e) => eventIds.includes(e.id))
				.map((e) => [e.id, e]),
		).values(),
	];
	return (
		<Disclosure
			title="根拠"
			count={evidence.size + events.length}
			hint={`参照資料 ${evidence.size}件・実行記録 ${events.length}件`}
		>
			{!evidence.size && !events.length && (
				<p className="memory-empty">参照できる根拠はまだありません。</p>
			)}
			{[...evidence].map(([id, e]) => (
				<div className="memory-evidence" key={id}>
					<a href={e.url} target="_blank" rel="noreferrer">
						{e.title} ↗
					</a>
					<blockquote>{e.quote}</blockquote>
				</div>
			))}
			{events.map((e) => (
				<div className="memory-evidence" key={e.id}>
					<strong>
						実行記録 #{e.id} · {e.type}
					</strong>
					<pre>{JSON.stringify(e.data, null, 2)}</pre>
				</div>
			))}
		</Disclosure>
	);
}
function KnowledgeCard({
	knowledge: k,
	detail,
}: {
	knowledge: MemoryKnowledge;
	detail: JobDetail;
}) {
	return (
		<article className="memory-card" aria-label={k.title}>
			<header className="memory-card-header">
				<div className="memory-card-meta">
					<span className="memory-badge">
						{k.skill
							? "Skill"
							: k.type === "procedure"
								? "手順"
								: "判断・ルール"}
					</span>
					{k.polarity === "negative" && (
						<span className="memory-badge memory-negative">避けるべきこと</span>
					)}
					{k.skill && (
						<a
							className="memory-download"
							href={`/api/jobs/${detail.job.id}/skills/${encodeURIComponent(k.id)}`}
						>
							SKILL.mdを保存 ↓
						</a>
					)}
				</div>
				<h4>{k.title}</h4>
				{k.skill && <p className="memory-hint">{k.skill.description}</p>}
			</header>
			<div className="memory-card-content">
				<Field title="概要">
					<p>{k.body}</p>
				</Field>
				<div className="memory-field-grid">
					<Field title="適用条件">
						<Items items={k.appliesWhen} />
					</Field>
					<Field title="適用しない条件">
						<Items items={k.notApplicableWhen} />
					</Field>
				</div>
				{k.skill && (
					<>
						<div className="memory-field-grid">
							<Field title="入力">
								<Items items={k.skill.inputs} />
							</Field>
							<Field title="出力">
								<Items items={k.skill.outputs} />
							</Field>
						</div>
						<Field title="前提">
							<Items items={k.skill.prerequisites} />
						</Field>
					</>
				)}
				{(k.skill || k.steps.length > 0) && (
					<Field title="手順">
						<Items items={k.steps} ordered />
					</Field>
				)}
				{(k.skill || k.verification.length > 0) && (
					<Field title="完了確認">
						<Items items={k.verification} />
					</Field>
				)}
				{k.skill && (
					<Field title="失敗時の対応">
						<Items items={k.skill.failureHandling} />
					</Field>
				)}
			</div>
			<div className="memory-card-details">
				<Disclosure
					title="未確認のこと"
					count={k.unknowns.length}
					hint="再利用する前に確認したい点"
				>
					<Items items={k.unknowns} />
				</Disclosure>
				<Evidence detail={detail} claimIds={k.claimIds} />
			</div>
		</article>
	);
}
function EpisodeCard({
	episode: e,
	detail,
}: {
	episode: MemoryEpisode;
	detail: JobDetail;
}) {
	const outcomes = {
		success: "成功",
		failure: "失敗",
		mixed: "一部成功",
		unknown: "結果未確認",
	};
	return (
		<article className="memory-card" aria-label={e.title}>
			<header className="memory-card-header">
				<div className="memory-card-meta">
					<span className="memory-badge">Episode</span>
					<span className={`memory-badge memory-outcome-${e.outcomeKind}`}>
						{outcomes[e.outcomeKind]}
					</span>
				</div>
				<h4>{e.title}</h4>
			</header>
			<div className="memory-card-content">
				<div className="memory-field-grid">
					<Field title="背景">
						<p>{e.context}</p>
					</Field>
					<Field title="目的">
						<p>{e.intent}</p>
					</Field>
				</div>
				<Field title="結果">
					<p>{e.outcome}</p>
				</Field>
				<Field title="学び" accent>
					<p>{e.lesson}</p>
				</Field>
			</div>
			<div className="memory-card-details">
				<Disclosure
					title="調査の経緯"
					count={2 + e.decisions.length}
					hint="観察・実施したこと・判断の記録"
				>
					<Field title="観察">
						<p>{e.observations}</p>
					</Field>
					<Field title="実施したこと">
						<p>{e.actionTaken}</p>
					</Field>
					<Field title="判断">
						<Items items={e.decisions} />
					</Field>
				</Disclosure>
				<Disclosure
					title="うまくいかなかったこと"
					count={e.failedApproach.length}
					hint="失敗した方法と、次回避けたい点"
					warning={e.failedApproach.length > 0}
				>
					<Items items={e.failedApproach} />
				</Disclosure>
				<Disclosure
					title="未解決の課題"
					count={e.openLoops.length}
					hint="引き続き調べる必要があること"
				>
					<Items items={e.openLoops} />
				</Disclosure>
				<Disclosure
					title="再利用のきっかけ"
					count={e.triggers.length}
					hint="この経験を参考にできる場面"
				>
					<Items items={e.triggers} />
				</Disclosure>
				<Evidence detail={detail} claimIds={e.claimIds} eventIds={e.eventIds} />
			</div>
		</article>
	);
}
export function DeliverableMemory({ detail }: { detail: JobDetail }) {
	const memory = detail.memory?.[0];
	if (!memory)
		return <p>本文を読解すると、再利用できるKnowledgeがここに保存されます。</p>;
	return (
		<div className="memory-collection">
			<section className="memory-group">
				<header className="memory-group-heading">
					<h3>
						Knowledge{" "}
						<span className="memory-count">{memory.knowledge.length}件</span>
					</h3>
					<p>再利用できる説明・判断・手順。適用条件を確認して活用できます。</p>
				</header>
				<div className="memory-card-list">
					{memory.knowledge.map((k) => (
						<KnowledgeCard key={k.id} knowledge={k} detail={detail} />
					))}
				</div>
				{!memory.knowledge.length && (
					<p className="memory-empty">
						登録できるまとまりのKnowledgeはまだありません。
					</p>
				)}
			</section>
			<section className="memory-group">
				<header className="memory-group-heading">
					<h3>
						Episode{" "}
						<span className="memory-count">{memory.episodes.length}件</span>
					</h3>
					<p>調査の結果と学び。経緯や根拠はカード内で確認できます。</p>
				</header>
				<div className="memory-card-list">
					{memory.episodes.map((e) => (
						<EpisodeCard key={e.id} episode={e} detail={detail} />
					))}
				</div>
				{!memory.episodes.length && (
					<p className="memory-empty">
						調査終了時に作成します。途中の行動は実行履歴に記録されています。
					</p>
				)}
			</section>
		</div>
	);
}
