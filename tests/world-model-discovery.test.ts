import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportArtifact } from "../packages/artifact";
import { hash } from "../packages/crawler";
import {
	applySectionUpdate,
	draftSchema,
	draftSectionCatalog,
	materialize,
	type Draft,
} from "../packages/research/deliverables";
import {
	discoveryCandidateId,
	discoveryNavigationContext,
	materializeDiscovery,
	mergeDiscovery,
	selectDiscoveryArtifact,
} from "../packages/research/world-model-discovery";
import {
	discoveryInputSchema,
	parseDiscoveryInput,
	type DiscoveryCandidateInput,
	type DiscoveryInput,
} from "../packages/research/world-model-schema";
import {
	makeArtifact,
	makeClaim,
	makeDetail,
	makeEvidence,
	makeSource,
	SAMPLE_QUOTE,
} from "./helpers/fixtures";

const emptyDraft = (): Draft => ({
	sections: [],
	knowledge: [],
	limitations: [],
	openQuestions: [],
});

const emptyDiscovery = (
	changeReason = "候補を提示できる根拠がなかった",
): DiscoveryInput => ({
	changeReason,
	candidates: [],
	gaps: [],
});

function candidate(
	over: Partial<DiscoveryCandidateInput> = {},
): DiscoveryCandidateInput {
	return {
		subject: "技術X",
		relation: "decreases",
		object: "応答待ち時間",
		correlationDirection: null,
		assessment: "hypothesis",
		basis: "inference",
		explanation: "資料は条件付きの短縮を述べており、因果は確定していない。",
		conditions: ["負荷が低いとき"],
		exceptions: [],
		scope: "実験室",
		alternatives: ["キャッシュ効果"],
		evidence: [
			{
				role: "supports",
				method: "experiment",
				note: "著者が待ち時間の低下を報告している。",
				citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
			},
		],
		gaps: [],
		...over,
	};
}

function reportDraft(discovery?: DiscoveryInput): Draft {
	return {
		sections: [
			{
				title: "条件",
				paragraphs: [
					{
						text: SAMPLE_QUOTE,
						kind: "finding",
						citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
					},
				],
			},
		],
		knowledge: [],
		limitations: [],
		openQuestions: [],
		worldModelDiscovery: discovery,
	};
}

test("S01 old drafts without discovery still parse and materialize", () => {
	const parsed = draftSchema.parse({
		sections: reportDraft().sections,
		knowledge: [],
		limitations: [],
		openQuestions: [],
	});
	expect(parsed.worldModelDiscovery).toBeUndefined();
	const result = materialize(parsed, [makeSource()], "j", 1, "theme");
	expect(result.artifact.worldModelDiscovery).toBeUndefined();
	expect(result.claims).toHaveLength(1);
});

test("S02 empty candidates persist as a generated empty result", () => {
	const result = materialize(
		reportDraft(emptyDiscovery()),
		[makeSource()],
		"j",
		1,
		"theme",
	);
	expect(result.artifact.worldModelDiscovery).toEqual({
		schemaVersion: 1,
		basedOnArtifactVersion: 1,
		changeReason: "候補を提示できる根拠がなかった",
		candidates: [],
		gaps: [],
	});
});

test("S03 rejects over-limit, empty subject and unknown enums", () => {
	expect(() =>
		discoveryInputSchema.parse({
			...emptyDiscovery(),
			candidates: Array.from({ length: 9 }, () => candidate()),
		}),
	).toThrow();
	expect(() =>
		parseDiscoveryInput({ ...candidate(), subject: "  " }),
	).toThrow();
	expect(() =>
		discoveryInputSchema.parse({
			...emptyDiscovery(),
			candidates: [{ ...candidate(), relation: "owns" }],
		}),
	).toThrow();
});

test("S04 rejects correlation without direction and directed relations with a direction", () => {
	expect(() =>
		parseDiscoveryInput({
			changeReason: "相関を記録",
			candidates: [
				candidate({
					relation: "correlates_with",
					correlationDirection: null,
				}),
			],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_CORRELATION_DIRECTION/);
	expect(() =>
		parseDiscoveryInput({
			changeReason: "因果を記録",
			candidates: [candidate({ correlationDirection: "positive" })],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_CORRELATION_DIRECTION/);
});

test("S05 rejects supported without supports and disputed without both roles", () => {
	expect(() =>
		parseDiscoveryInput({
			changeReason: "支持",
			candidates: [
				candidate({
					assessment: "supported",
					basis: "source_statement",
					evidence: [
						{
							role: "background",
							method: "author_statement",
							note: "背景のみ",
							citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
						},
					],
				}),
			],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_EVIDENCE_ROLE/);
	expect(() =>
		parseDiscoveryInput({
			changeReason: "競合",
			candidates: [
				candidate({
					assessment: "disputed",
					evidence: [
						{
							role: "supports",
							method: "observation",
							note: "支持のみ",
							citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
						},
					],
				}),
			],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_EVIDENCE_ROLE/);
});

test("S06 rejects inferred causal relations marked supported", () => {
	expect(() =>
		parseDiscoveryInput({
			changeReason: "推論を確定扱い",
			candidates: [candidate({ assessment: "supported", basis: "inference" })],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_INFERENCE_ASSESSMENT/);
	expect(
		parseDiscoveryInput({
			changeReason: "仮説として保持",
			candidates: [candidate()],
			gaps: [],
		}).candidates[0].assessment,
	).toBe("hypothesis");
});

test("S07 ids stay stable when assessment changes and rotate when conditions change", () => {
	const base = candidate();
	const same = discoveryCandidateId(
		candidate({ assessment: "insufficient_evidence", explanation: "別理由" }),
	);
	expect(same).toBe(discoveryCandidateId(base));
	expect(discoveryCandidateId(candidate({ conditions: ["別条件"] }))).not.toBe(
		discoveryCandidateId(base),
	);
});

test("S08 swapping correlate ends keeps the id while causal ends do not", () => {
	const left = candidate({
		relation: "correlates_with",
		correlationDirection: "positive",
		subject: "負荷",
		object: "遅延",
	});
	const swapped = candidate({
		relation: "correlates_with",
		correlationDirection: "positive",
		subject: "遅延",
		object: "負荷",
	});
	expect(discoveryCandidateId(left)).toBe(discoveryCandidateId(swapped));
	expect(
		discoveryCandidateId(candidate({ subject: "A", object: "B" })),
	).not.toBe(discoveryCandidateId(candidate({ subject: "B", object: "A" })));
});

test("S09 duplicate candidate ids are rejected instead of merged", () => {
	const incoming = {
		changeReason: "重複",
		candidates: [candidate(), candidate({ explanation: "別評価" })],
		gaps: [],
	};
	expect(() => mergeDiscovery(undefined, incoming)).toThrow(
		/DUPLICATE_DISCOVERY_CANDIDATE/,
	);
	expect(() =>
		materializeDiscovery(incoming, [makeSource()], 1),
	).toThrow(/DUPLICATE_DISCOVERY_CANDIDATE/);
});

test("M01 null or omitted discovery updates keep the previous candidates", () => {
	const previous = {
		changeReason: "初回",
		candidates: [candidate()],
		gaps: [],
	};
	expect(mergeDiscovery(previous, null)).toEqual(previous);
	expect(mergeDiscovery(previous, undefined)).toEqual(previous);
});

test("M02 an explicit empty result deletes candidates while a replacement without a reason is rejected", () => {
	const previous = {
		changeReason: "初回",
		candidates: [candidate()],
		gaps: [],
	};
	expect(
		mergeDiscovery(previous, emptyDiscovery("根拠不足のため候補を取り下げた")),
	).toEqual(emptyDiscovery("根拠不足のため候補を取り下げた"));
	expect(() =>
		mergeDiscovery(previous, {
			changeReason: "",
			candidates: [candidate({ subject: "別主体" })],
			gaps: [],
		}),
	).toThrow();
});

test("M03 full draft updates and section updates share keep and replace rules", () => {
	const previous = reportDraft({
		changeReason: "初回",
		candidates: [candidate()],
		gaps: [],
	});
	const sectionId = draftSectionCatalog(previous)[0].sectionId;
	const kept = applySectionUpdate(previous, {
		sections: [
			{
				operation: "replace",
				sectionId,
				section: previous.sections[0],
			},
		],
		knowledge: [],
		limitations: [],
		openQuestions: [],
	});
	expect(kept.worldModelDiscovery?.candidates).toHaveLength(1);
	const replaced = applySectionUpdate(previous, {
		sections: [
			{
				operation: "replace",
				sectionId,
				section: previous.sections[0],
			},
		],
		knowledge: [],
		limitations: [],
		openQuestions: [],
		worldModelDiscovery: emptyDiscovery("部分更新で候補を空にした"),
	});
	expect(replaced.worldModelDiscovery?.candidates).toEqual([]);
});

test("E01 shared citations reuse evidence and do not add claims", () => {
	const sources = [makeSource()];
	const without = materialize(reportDraft(), sources, "j", 1, "theme");
	const withDiscovery = materialize(
		reportDraft({
			changeReason: "同一引用",
			candidates: [candidate()],
			gaps: [],
		}),
		sources,
		"j",
		1,
		"theme",
	);
	expect(withDiscovery.claims).toHaveLength(without.claims.length);
	expect(withDiscovery.evidence).toHaveLength(without.evidence.length);
	expect(withDiscovery.artifact.claimIds).toEqual(without.artifact.claimIds);
});

test("E02 unknown or hash-mismatched discovery citations fail materialize", () => {
	expect(() =>
		materialize(
			reportDraft({
				changeReason: "未知",
				candidates: [
					candidate({
						evidence: [
							{
								role: "supports",
								method: "unknown",
								note: "欠落",
								citations: [{ sourceId: "missing", firstLine: 1, lastLine: 1 }],
							},
						],
					}),
				],
				gaps: [],
			}),
			[makeSource()],
			"j",
			1,
			"theme",
		),
	).toThrow(/INVALID_SOURCE_REFERENCE/);
	const source = makeSource({ hash: "0".repeat(64) });
	expect(() =>
		materializeDiscovery(
			{
				changeReason: "改ざん",
				candidates: [candidate()],
				gaps: [],
			},
			[source],
			1,
		),
	).toThrow(/INVALID_SOURCE_REFERENCE/);
});

test("E03 and E04 export validation rejects missing evidence and version mismatch", () => {
	const source = makeSource();
	const materialized = materialize(
		reportDraft({
			changeReason: "保存",
			candidates: [candidate()],
			gaps: [],
		}),
		[source],
		"job",
		1,
		"theme",
	);
	const detail = makeDetail({
		sources: [source],
		evidence: materialized.evidence,
		claims: materialized.claims,
		artifacts: [materialized.artifact],
	});
	const missing = structuredClone(materialized.artifact);
	const missingDiscovery = missing.worldModelDiscovery;
	if (!missingDiscovery) throw Error("expected discovery");
	missingDiscovery.candidates[0].evidence[0].evidenceIds = ["e:missing"];
	expect(() =>
		exportArtifact(
			{ ...detail, artifacts: [missing] },
			missing,
			mkdtempSync(join(tmpdir(), "wm-")),
		),
	).toThrow(/INVALID_DISCOVERY_EVIDENCE_REFERENCE/);
	const mismatched = structuredClone(materialized.artifact);
	const mismatchedDiscovery = mismatched.worldModelDiscovery;
	if (!mismatchedDiscovery) throw Error("expected discovery");
	mismatchedDiscovery.basedOnArtifactVersion = 9;
	expect(() =>
		exportArtifact(
			{ ...detail, artifacts: [mismatched] },
			mismatched,
			mkdtempSync(join(tmpdir(), "wm-")),
		),
	).toThrow(/INVALID_DISCOVERY_ARTIFACT_VERSION/);
	const inferredSupported = structuredClone(materialized.artifact);
	const inferredDiscovery = inferredSupported.worldModelDiscovery;
	if (!inferredDiscovery) throw Error("expected discovery");
	inferredDiscovery.candidates[0] = {
		...inferredDiscovery.candidates[0],
		assessment: "supported",
		basis: "inference",
	};
	expect(() =>
		exportArtifact(
			{ ...detail, artifacts: [inferredSupported] },
			inferredSupported,
			mkdtempSync(join(tmpdir(), "wm-")),
		),
	).toThrow(/INVALID_DISCOVERY_INFERENCE_ASSESSMENT/);
	const duplicated = structuredClone(materialized.artifact);
	const duplicatedDiscovery = duplicated.worldModelDiscovery;
	if (!duplicatedDiscovery) throw Error("expected discovery");
	duplicatedDiscovery.candidates.push(duplicatedDiscovery.candidates[0]);
	expect(() =>
		exportArtifact(
			{ ...detail, artifacts: [duplicated] },
			duplicated,
			mkdtempSync(join(tmpdir(), "wm-")),
		),
	).toThrow(/DUPLICATE_DISCOVERY_CANDIDATE/);
});

test("X01 export round-trips discovery evidence references", () => {
	const source = makeSource();
	const materialized = materialize(
		reportDraft({
			changeReason: "出力",
			candidates: [candidate()],
			gaps: [],
		}),
		[source],
		"job",
		2,
		"theme",
	);
	const dir = mkdtempSync(join(tmpdir(), "wm-export-"));
	try {
		const exported = exportArtifact(
			makeDetail({
				job: makeDetail().job,
				sources: [source],
				evidence: materialized.evidence,
				claims: materialized.claims,
				artifacts: [materialized.artifact],
			}),
			materialized.artifact,
			dir,
		);
		const saved = JSON.parse(
			readFileSync(join(exported, "evidence.json"), "utf8"),
		);
		expect(saved.artifact.worldModelDiscovery.candidates).toHaveLength(1);
		const evidenceId =
			saved.artifact.worldModelDiscovery.candidates[0].evidence[0]
				.evidenceIds[0];
		expect(
			saved.evidence.some((item: { id: string }) => item.id === evidenceId),
		).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selectDiscoveryArtifact prefers the newest generated result including empty ones", () => {
	const old = makeArtifact({
		version: 1,
		worldModelDiscovery: {
			schemaVersion: 1,
			basedOnArtifactVersion: 1,
			changeReason: "旧",
			candidates: [
				{
					...candidate(),
					id: `wmc:${"a".repeat(24)}`,
					evidence: [
						{
							role: "supports",
							method: "experiment",
							note: "旧",
							evidenceIds: ["ev-1"],
						},
					],
				},
			],
			gaps: [],
		},
	});
	const latestEmpty = makeArtifact({
		id: "art-2",
		version: 2,
		worldModelDiscovery: {
			schemaVersion: 1,
			basedOnArtifactVersion: 2,
			changeReason: "再評価で空",
			candidates: [],
			gaps: [],
		},
	});
	const latestBare = makeArtifact({ id: "art-3", version: 3 });
	expect(selectDiscoveryArtifact([old, latestEmpty])).toEqual({
		artifact: latestEmpty,
		stale: false,
	});
	expect(selectDiscoveryArtifact([old, latestBare])).toEqual({
		artifact: old,
		stale: true,
	});
	expect(selectDiscoveryArtifact([latestBare])).toEqual({
		artifact: undefined,
		stale: false,
	});
});

test("navigation context sends summaries without quotes or explanations", () => {
	const context = discoveryNavigationContext({
		changeReason: "要約",
		candidates: [candidate({ explanation: "長い説明を渡さない" })],
		gaps: [
			{
				kind: "missing_condition",
				question: "別環境でも同じか",
				relevance: "optional",
				reason: "適用不明",
			},
		],
	});
	expect(JSON.stringify(context)).not.toContain("長い説明を渡さない");
	expect(context?.candidates[0]).toMatchObject({
		subject: "技術X",
		relation: "decreases",
		object: "応答待ち時間",
	});
	expect(context?.gaps).toHaveLength(1);
});

test("quality rule: conditional improvement keeps conditions", () => {
	const parsed = parseDiscoveryInput({
		changeReason: "条件付き改善",
		candidates: [candidate({ conditions: ["負荷が低いとき"] })],
		gaps: [],
	});
	expect(parsed.candidates[0].conditions).toEqual(["負荷が低いとき"]);
	expect(parsed.candidates[0].assessment).not.toBe("supported");
});

test("quality rule: correlation is not stored as causation", () => {
	expect(() =>
		parseDiscoveryInput({
			changeReason: "相関を因果へ昇格",
			candidates: [
				candidate({
					relation: "causes",
					correlationDirection: "positive",
				}),
			],
			gaps: [],
		}),
	).toThrow(/INVALID_DISCOVERY_CORRELATION_DIRECTION/);
	expect(
		parseDiscoveryInput({
			changeReason: "相関として記録",
			candidates: [
				candidate({
					relation: "correlates_with",
					correlationDirection: "positive",
					assessment: "supported",
					basis: "source_statement",
				}),
			],
			gaps: [],
		}).candidates[0].relation,
	).toBe("correlates_with");
});

test("quality rule: supporting and contradicting evidence can coexist", () => {
	const parsed = parseDiscoveryInput({
		changeReason: "支持と反証",
		candidates: [
			candidate({
				assessment: "disputed",
				evidence: [
					{
						role: "supports",
						method: "observation",
						note: "支持資料",
						citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
					},
					{
						role: "contradicts",
						method: "experiment",
						note: "反証資料",
						citations: [{ sourceId: "src-1", firstLine: 1, lastLine: 1 }],
					},
				],
			}),
		],
		gaps: [],
	});
	expect(parsed.candidates[0].evidence.map((item) => item.role)).toEqual([
		"supports",
		"contradicts",
	]);
});

test("quality rule: definition-only empty discovery is persistable", () => {
	const result = materialize(
		reportDraft(
			emptyDiscovery("定義の説明しかなく、関係を示す測定がなかった"),
		),
		[makeSource()],
		"j",
		1,
		"theme",
	);
	expect(result.artifact.worldModelDiscovery?.candidates).toEqual([]);
	expect(result.artifact.worldModelDiscovery?.changeReason).toContain("定義");
});

test("source hash helper remains aligned with snapshot hashing", () => {
	const source = makeSource();
	expect(hash(source.text)).toBe(source.hash);
	expect(makeClaim().evidenceIds).toEqual([makeEvidence().id]);
	expect(emptyDraft().sections).toEqual([]);
});
