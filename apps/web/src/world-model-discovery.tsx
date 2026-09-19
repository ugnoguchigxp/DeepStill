import type { JobDetail } from "../../../packages/contracts";
import { pdfEvidencePages, pdfEvidenceUrl } from "../../../packages/core/pdf";
import { selectDiscoveryArtifact } from "../../../packages/research/world-model-view";
import type {
	DiscoveryAssessment,
	DiscoveryBasis,
	DiscoveryCandidate,
	DiscoveryCorrelationDirection,
	DiscoveryEvidenceMethod,
	DiscoveryEvidenceRole,
	DiscoveryGapInput,
	DiscoveryGapKind,
	DiscoveryRelation,
	WorldModelDiscovery as WorldModelDiscoveryResult,
} from "../../../packages/research/world-model-schema";

const relationLabels: Record<DiscoveryRelation, string> = {
	causes: "影響・因果",
	increases: "増加させる",
	decreases: "減少させる",
	enables: "可能にする",
	inhibits: "抑制する",
	correlates_with: "相関",
	depends_on: "依存",
	has_goal: "目標を持つ",
	serves_goal: "目標に資する",
};
const assessmentLabels: Record<DiscoveryAssessment, string> = {
	hypothesis: "仮説",
	supported: "支持する根拠あり",
	disputed: "証拠が競合",
	insufficient_evidence: "判断不能",
	refuted: "反証あり",
};
const basisLabels: Record<DiscoveryBasis, string> = {
	source_statement: "資料に記載",
	inference: "根拠からの推論",
};
const roleLabels: Record<DiscoveryEvidenceRole, string> = {
	supports: "支持",
	contradicts: "反証",
	background: "背景",
};
const methodLabels: Record<DiscoveryEvidenceMethod, string> = {
	experiment: "実験",
	observation: "観測",
	theory: "理論的説明",
	author_statement: "著者の主張",
	unknown: "不明",
};
const correlationDirectionLabels: Record<DiscoveryCorrelationDirection, string> =
	{
		positive: "正の相関",
		negative: "負の相関",
		unknown: "向きは不明",
	};
const gapKindLabels: Record<DiscoveryGapKind, string> = {
	missing_knowledge: "知識不足",
	unknown_causal_direction: "因果方向不明",
	missing_mechanism: "仕組み不明",
	missing_condition: "成立条件不足",
	conflicting_evidence: "根拠の競合",
	unknown_applicability: "適用範囲が不明",
};

function labeled<T extends string>(
	labels: Record<T, string>,
	value: string,
): string | undefined {
	return Object.hasOwn(labels, value) ? labels[value as T] : undefined;
}

export function WorldModelDiscovery({ detail }: { detail: JobDetail }) {
	const { artifact, stale } = selectDiscoveryArtifact(detail.artifacts);
	const stored = artifact?.worldModelDiscovery;
	const discovery = Array.isArray(stored?.candidates) ? stored : undefined;
	const latest = detail.artifacts.reduce(
		(current, item) =>
			item.version > (current?.version ?? 0) ? item : current,
		detail.artifacts[0],
	);
	const running = [
		"queued",
		"running",
		"finalizing",
		"cancel_requested",
	].includes(detail.job.status);
	const updateFailed = ["partial", "failed", "cancelled"].includes(
		detail.job.status,
	);
	return (
		<div className="world-model-panel">
			<p className="world-model-lead">
				調査資料から見つかった関係の候補です。ワールドモデルへの登録はまだ行われていません
			</p>
			{artifact && (
				<p className="world-model-meta">
					参照している成果物の版: v{artifact.version}
					{stale && latest ? ` / 最新レポートは v${latest.version}` : ""}
				</p>
			)}
			{running && (
				<p className="world-model-notice">
					調査途中の候補です。完了結果ではありません。
				</p>
			)}
			{updateFailed && (
				<p className="world-model-notice">
					今回の更新は完了できませんでした。以前までに得られた候補は残しています。
				</p>
			)}
			{(artifact?.fixture || detail.job.mode === "mock") && (
				<p className="world-model-notice">
					検証用データです。実際のWeb調査結果ではありません。
				</p>
			)}
			{stale && artifact && latest && (
				<p className="world-model-stale">
					レポートはv{latest.version}に更新されています。以下はv
					{artifact.version}
					の調査時点の候補で、再評価されていません
				</p>
			)}
			{!discovery ? (
				<p className="world-model-empty">
					この調査では、ワールドモデル向けの発見処理はまだ行われていません
				</p>
			) : (
				<DiscoveryResult detail={detail} discovery={discovery} />
			)}
		</div>
	);
}
export { WorldModelDiscovery as WorldModelDiscoveryPanel };

function DiscoveryResult({
	detail,
	discovery,
}: {
	detail: JobDetail;
	discovery: WorldModelDiscoveryResult;
}) {
	return (
		<>
			{!discovery.candidates.length && (
				<p className="world-model-empty">
					読解した資料から、根拠を付けて提示できる関係候補は見つかりませんでした
				</p>
			)}
			<div className="world-model-card-list">
				{discovery.candidates.map((candidate) => (
					<CandidateCard
						detail={detail}
						candidate={candidate}
						key={candidate.id}
					/>
				))}
			</div>
			{(discovery.gaps.length > 0 ||
				discovery.candidates.some((candidate) => candidate.gaps.length)) && (
				<section className="world-model-gaps">
					<h3>未解決の問い</h3>
					<ul>
						{discovery.gaps.map((gap) => (
							<GapItem
								gap={gap}
								key={`top:${gap.kind}:${gap.relevance}:${gap.question}`}
							/>
						))}
						{discovery.candidates.flatMap((item) =>
							item.gaps.map((gap) => (
								<GapItem
									gap={gap}
									key={`${item.id}:${gap.kind}:${gap.relevance}:${gap.question}`}
								/>
							)),
						)}
					</ul>
				</section>
			)}
		</>
	);
}

function CandidateCard({
	detail,
	candidate,
}: {
	detail: JobDetail;
	candidate: DiscoveryCandidate;
}) {
	const relation = labeled(relationLabels, candidate.relation);
	const assessment = labeled(assessmentLabels, candidate.assessment);
	const basis = labeled(basisLabels, candidate.basis);
	const direction = labeled(
		correlationDirectionLabels,
		candidate.correlationDirection ?? "",
	);
	const arrow = candidate.relation === "correlates_with" ? "↔" : "→";
	const grouped = {
		supports: candidate.evidence.filter((item) => item.role === "supports"),
		contradicts: candidate.evidence.filter(
			(item) => item.role === "contradicts",
		),
		background: candidate.evidence.filter((item) => item.role === "background"),
	};
	return (
		<article
			className="world-model-card"
			aria-label={`${candidate.subject} ${candidate.object}`}
		>
			<header className="world-model-card-header">
				<p className="world-model-relation">
					<span>{candidate.subject}</span>
					<span className="world-model-arrow">{arrow}</span>
					<span>{candidate.object}</span>
				</p>
				<p className="world-model-card-meta">
					{relation ?? "関係の種類を表示できません"}
					{" / "}
					{assessment ?? "評価を表示できません"}
					{candidate.relation === "correlates_with"
						? ` / ${direction ?? "相関の向きを表示できません"}`
						: ""}
				</p>
				{candidate.assessment === "supported" && (
					<p className="world-model-caveat">LLMによる評価・独立審査なし</p>
				)}
			</header>
			<div className="world-model-card-content">
				<section className="world-model-field">
					<h5>なぜその関係を考えたか</h5>
					<p>{candidate.explanation}</p>
					<p>
						根拠の性質:{" "}
						{basis
							? `${basis}（${
									candidate.basis === "source_statement"
										? "資料が実際に示している範囲"
										: "資料から組み立てた仮説"
								}）`
							: "表示できません"}
					</p>
				</section>
				<section className="world-model-field">
					<h5>成立条件</h5>
					{candidate.conditions.length ? (
						<ul>
							{candidate.conditions.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					) : (
						<p className="world-model-empty">条件の記載なし</p>
					)}
				</section>
				<section className="world-model-field">
					<h5>適用できない条件</h5>
					{candidate.exceptions.length ? (
						<ul>
							{candidate.exceptions.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					) : (
						<p className="world-model-empty">例外の記載なし</p>
					)}
				</section>
				<section className="world-model-field">
					<h5>時間・対象範囲</h5>
					<p>{candidate.scope ?? "適用範囲は未確認"}</p>
				</section>
				{(["supports", "contradicts", "background"] as const).map((role) => (
					<details className="world-model-disclosure" key={role}>
						<summary>
							{roleLabels[role]}
							<span className="world-model-count">
								{grouped[role].length}件
							</span>
						</summary>
						<div className="world-model-disclosure-body">
							{grouped[role].length ? (
								grouped[role].map((item) => (
									<EvidenceBlock
										detail={detail}
										item={item}
										key={`${role}:${item.note}:${item.evidenceIds.join(",")}`}
									/>
								))
							) : (
								<p className="world-model-empty">この区分の根拠はありません</p>
							)}
						</div>
					</details>
				))}
				<section className="world-model-field">
					<h5>別の原因や説明</h5>
					{candidate.alternatives.length ? (
						<ul>
							{candidate.alternatives.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					) : (
						<p className="world-model-empty">記載なし</p>
					)}
				</section>
				{candidate.gaps.length > 0 && (
					<section className="world-model-field">
						<h5>この候補の未解決点</h5>
						<ul>
							{candidate.gaps.map((gap) => (
								<GapItem
									gap={gap}
									key={`${candidate.id}:${gap.kind}:${gap.question}`}
								/>
							))}
						</ul>
					</section>
				)}
			</div>
		</article>
	);
}

function EvidenceBlock({
	detail,
	item,
}: {
	detail: JobDetail;
	item: DiscoveryCandidate["evidence"][number];
}) {
	const method = labeled(methodLabels, item.method);
	return (
		<div className="world-model-evidence">
			<p>{item.note}</p>
			<p>根拠の性質: {method ?? "表示できません"}</p>
			{item.evidenceIds.map((id) => {
				const evidence = detail.evidence.find((entry) => entry.id === id);
				const source = detail.sources.find(
					(entry) => entry.id === evidence?.snapshotId,
				);
				if (!evidence || !source)
					return (
						<p className="world-model-empty" key={id}>
							根拠を参照できません
						</p>
					);
				const pages = pdfEvidencePages(source, evidence.start, evidence.end);
				return (
					<div key={id}>
						<blockquote>{evidence.quote}</blockquote>
						<p>
							<a
								href={pdfEvidenceUrl(source, evidence.start, evidence.end)}
								rel="noreferrer"
								target="_blank"
							>
								{source.title || source.finalUrl} ↗
							</a>
							{pages.length ? ` / PDF p. ${pages.join(", ")}` : ""}
						</p>
					</div>
				);
			})}
		</div>
	);
}

function GapItem({ gap }: { gap: DiscoveryGapInput }) {
	const kind = labeled(gapKindLabels, gap.kind);
	return (
		<li>
			<strong>
				{kind ?? "種類を表示できません"} /{" "}
				{gap.relevance === "required"
					? "元の依頼への回答に必要"
					: "任意の追加調査"}
			</strong>
			<p>{gap.question}</p>
			<p>{gap.reason}</p>
		</li>
	);
}
