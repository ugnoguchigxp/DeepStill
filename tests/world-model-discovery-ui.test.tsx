/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { WorldModelDiscovery } from "../apps/web/src/world-model-discovery";
import type { WorldModelDiscovery as WorldModelDiscoveryResult } from "../packages/research/world-model-schema";
import {
	makeArtifact,
	makeDetail,
	makeEvidence,
	makeJob,
	makeSource,
	SAMPLE_QUOTE,
} from "./helpers/fixtures";

afterEach(cleanup);

const id = `wmc:${"ab".repeat(12)}`;

function discovery(
	over: Partial<WorldModelDiscoveryResult> = {},
): WorldModelDiscoveryResult {
	return {
		schemaVersion: 1,
		basedOnArtifactVersion: 1,
		changeReason: "初回",
		candidates: [],
		gaps: [],
		...over,
	};
}

function candidate(
	over: Partial<WorldModelDiscoveryResult["candidates"][number]> = {},
) {
	return {
		id,
		subject: "技術X",
		relation: "decreases" as const,
		object: "応答待ち時間",
		correlationDirection: null,
		assessment: "hypothesis" as const,
		basis: "inference" as const,
		explanation: "条件付きの短縮が報告されている。",
		conditions: ["負荷が低いとき"],
		exceptions: [],
		scope: "実験室",
		alternatives: ["キャッシュ"],
		evidence: [
			{
				role: "supports" as const,
				method: "experiment" as const,
				note: "著者が待ち時間の低下を報告",
				evidenceIds: ["ev-1"],
			},
		],
		gaps: [],
		...over,
	};
}

test("U01 distinguishes ungenerated, empty, and gap-only results", () => {
	render(<WorldModelDiscovery detail={makeDetail()} />);
	expect(
		screen.getByText(
			"この調査では、ワールドモデル向けの発見処理はまだ行われていません",
		),
	).toBeTruthy();
	cleanup();
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [makeArtifact({ worldModelDiscovery: discovery() })],
			})}
		/>,
	);
	expect(
		screen.getByText(
			"読解した資料から、根拠を付けて提示できる関係候補は見つかりませんでした",
		),
	).toBeTruthy();
	cleanup();
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [
					makeArtifact({
						worldModelDiscovery: discovery({
							gaps: [
								{
									kind: "missing_knowledge",
									question: "関係を示す測定はあるか",
									relevance: "optional",
									reason: "定義しかない",
								},
							],
						}),
					}),
				],
			})}
		/>,
	);
	expect(screen.getByText("関係を示す測定はあるか")).toBeTruthy();
	expect(screen.getByText("未解決の問い")).toBeTruthy();
});

test("U02 renders correlation direction, assessments and evidence roles", () => {
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [
					makeArtifact({
						worldModelDiscovery: discovery({
							candidates: [
								candidate({
									id: `wmc:${"a".repeat(24)}`,
									relation: "correlates_with",
									correlationDirection: "positive",
									assessment: "supported",
									basis: "source_statement",
									gaps: [
										{
											kind: "missing_condition",
											question: "負荷が高いときも同じか",
											relevance: "required",
											reason: "条件付き報告のみ",
										},
									],
								}),
								candidate({
									id: `wmc:${"b".repeat(24)}`,
									subject: "手法Y",
									object: "誤差",
									assessment: "disputed",
									evidence: [
										{
											role: "supports",
											method: "observation",
											note: "支持側",
											evidenceIds: ["ev-1"],
										},
										{
											role: "contradicts",
											method: "observation",
											note: "反証側",
											evidenceIds: ["ev-1"],
										},
									],
								}),
								candidate({
									id: `wmc:${"c".repeat(24)}`,
									subject: "手法Z",
									object: "効果",
									assessment: "refuted",
									evidence: [
										{
											role: "contradicts",
											method: "experiment",
											note: "反証のみ",
											evidenceIds: ["ev-1"],
										},
									],
								}),
							],
						}),
					}),
				],
			})}
		/>,
	);
	expect(
		screen.getByText((text) => text.includes("正の相関")),
	).toBeTruthy();
	expect(screen.getAllByText("→").length).toBeGreaterThan(0);
	expect(
		screen.getByText((text) => text.includes("支持する根拠あり")),
	).toBeTruthy();
	expect(screen.getByText((text) => text.includes("証拠が競合"))).toBeTruthy();
	expect(screen.getByText((text) => text.includes("反証あり"))).toBeTruthy();
	expect(screen.getByText("LLMによる評価・独立審査なし")).toBeTruthy();
	expect(screen.getByText("支持側")).toBeTruthy();
	expect(screen.getByText("反証側")).toBeTruthy();
	expect(screen.getAllByText("負荷が高いときも同じか").length).toBeGreaterThan(1);
	expect(screen.getByText("この候補の未解決点")).toBeTruthy();
	expect(screen.getAllByText(SAMPLE_QUOTE).length).toBeGreaterThan(0);
});

test("U03 shows a stale notice when only an older version has discovery", () => {
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [
					makeArtifact({
						version: 1,
						worldModelDiscovery: discovery({
							candidates: [candidate()],
						}),
					}),
					makeArtifact({ id: "art-2", version: 2 }),
				],
			})}
		/>,
	);
	expect(
		screen.getByText(
			"レポートはv2に更新されています。以下はv1の調査時点の候補で、再評価されていません",
		),
	).toBeTruthy();
	expect(screen.getByText("技術X")).toBeTruthy();
});

test("U04 prefers a newer empty result over older candidates", () => {
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [
					makeArtifact({
						version: 1,
						worldModelDiscovery: discovery({
							candidates: [candidate()],
						}),
					}),
					makeArtifact({
						id: "art-2",
						version: 2,
						worldModelDiscovery: discovery({
							basedOnArtifactVersion: 2,
							changeReason: "再評価で空",
						}),
					}),
				],
			})}
		/>,
	);
	expect(
		screen.getByText(
			"読解した資料から、根拠を付けて提示できる関係候補は見つかりませんでした",
		),
	).toBeTruthy();
	expect(screen.queryByText("技術X")).toBeNull();
});

test("U05 switching jobs does not keep the previous cards", () => {
	const first = makeDetail({
		job: makeJob({ id: "job-a" }),
		artifacts: [
			makeArtifact({
				worldModelDiscovery: discovery({ candidates: [candidate()] }),
			}),
		],
	});
	const second = makeDetail({
		job: makeJob({ id: "job-b", topic: "別調査" }),
		sources: [makeSource()],
		evidence: [makeEvidence()],
		artifacts: [makeArtifact({ id: "art-b" })],
	});
	const view = render(<WorldModelDiscovery detail={first} />);
	expect(screen.getByText("技術X")).toBeTruthy();
	view.rerender(<WorldModelDiscovery detail={second} />);
	expect(screen.queryByText("技術X")).toBeNull();
	expect(
		screen.getByText(
			"この調査では、ワールドモデル向けの発見処理はまだ行われていません",
		),
	).toBeTruthy();
});

test("unknown enums stay as display failures instead of successful fallbacks", () => {
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				artifacts: [
					makeArtifact({
						worldModelDiscovery: discovery({
							candidates: [
								candidate({
									basis: "guess" as never,
									relation: "owns" as never,
									assessment: "proven" as never,
									correlationDirection: "up" as never,
								}),
							],
						}),
					}),
				],
			})}
		/>,
	);
	expect(
		screen.getByText((text) => text.includes("関係の種類を表示できません")),
	).toBeTruthy();
	expect(
		screen.getByText((text) => text.includes("評価を表示できません")),
	).toBeTruthy();
	expect(
		screen.getByText((text) => text.includes("根拠の性質") && text.includes("表示できません")),
	).toBeTruthy();
	expect(screen.queryByText("資料から組み立てた仮説")).toBeNull();
});

test("partial jobs keep existing candidates and say the update failed", () => {
	render(
		<WorldModelDiscovery
			detail={makeDetail({
				job: makeJob({ status: "partial", reason: "token_budget" }),
				artifacts: [
					makeArtifact({
						worldModelDiscovery: discovery({ candidates: [candidate()] }),
					}),
				],
			})}
		/>,
	);
	expect(screen.getByText("技術X")).toBeTruthy();
	expect(
		screen.getByText(
			"今回の更新は完了できませんでした。以前までに得られた候補は残しています。",
		),
	).toBeTruthy();
});
