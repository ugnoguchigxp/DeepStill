import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	buildDeepStillCapabilities,
	projectResearchResult,
} from "../packages/research-engine";
import { projectWebEvidence } from "../packages/research/resource";
import { repositoryIdentityFromConfig } from "../packages/repository-identity";
import {
	makeArtifact,
	makeClaim,
	makeDetail,
	makeEvidence,
	makeJob,
	makeMemory,
	makeSource,
} from "./helpers/fixtures";

describe("research adapter boundaries", () => {
	test("web evidence projects stable UTF-8 and UTF-16 locators", () => {
		const text = "前置き😀\n検証する引用です。\n後続";
		const quote = "検証する引用です。";
		const start = text.indexOf(quote);
		const source = makeSource({ text });
		const evidence = makeEvidence({
			snapshotId: source.id,
			quote,
			start,
			end: start + quote.length,
		});
		const locator = projectWebEvidence(source, evidence);
		expect(locator.resource.connectorKind).toBe("web");
		expect(locator.fragment).toEqual({
			kind: "utf8_bytes",
			value: {
				start: Buffer.byteLength(text.slice(0, start)),
				end: Buffer.byteLength(text.slice(0, start + quote.length)),
				utf16Start: start,
				utf16End: start + quote.length,
			},
		});
		expect(locator.quoteHash).toBe(
			createHash("sha256").update(quote).digest("hex"),
		);
	});

	test("evidence projection rejects stale snapshots and changed quotes", () => {
		const source = makeSource();
		expect(() =>
			projectWebEvidence({ ...source, hash: "0".repeat(64) }, makeEvidence()),
		).toThrow("SNAPSHOT_HASH_MISMATCH");
		expect(() =>
			projectWebEvidence(source, makeEvidence({ quote: "changed quote" })),
		).toThrow("EVIDENCE_QUOTE_MISMATCH");
		expect(() =>
			projectWebEvidence(
				makeSource({ finalUrl: "file:///private/source" }),
				makeEvidence(),
			),
		).toThrow("INVALID_WEB_RESOURCE_ID");
		expect(() =>
			projectWebEvidence(
				makeSource({ finalUrl: "https://user:secret@example.test/source" }),
				makeEvidence(),
			),
		).toThrow("INVALID_WEB_RESOURCE_ID");
	});

	test("result projection excludes internal operations and is deterministic", () => {
		const detail = makeDetail({
			artifacts: [makeArtifact({ memoryId: "memory:v1" })],
			memory: [makeMemory({ id: "memory:v1" })],
			candidates: [
				...makeDetail().candidates,
				{
					id: "episode-candidate",
					type: "episode",
					text: "internal episode candidate",
					claimIds: ["c1"],
					adoption: "pending",
					eventIds: [1],
				},
			],
			operations: [{ id: "secret-operation", prompt: "do not export" }],
		});
		const first = projectResearchResult(detail);
		const second = projectResearchResult(detail);
		expect(second.resultHash).toBe(first.resultHash);
		expect(first.execution.resultAvailable).toBe(true);
		expect(first.evidence[0].claimIds).toEqual(["c1"]);
		expect(first.episodeSource?.episodes[0].id).toBe("ep:run");
		expect(first.episodeSource?.events.map((event) => event.id)).toEqual([1]);
		expect(first.knowledgeCandidates).toHaveLength(1);
		expect(first.knowledgeCandidates[0].type).toBe("knowledge");
		expect(JSON.stringify(first)).not.toContain("internal episode candidate");
		expect(JSON.stringify(first)).not.toContain("secret-operation");
		expect(JSON.stringify(first)).not.toContain("do not export");
	});

	test("result projection rejects dangling claim and evidence references", () => {
		expect(() =>
			projectResearchResult(
				makeDetail({ artifacts: [makeArtifact({ claimIds: ["missing"] })] }),
			),
		).toThrow("INVALID_CLAIM_REFERENCE");
		expect(() =>
			projectResearchResult(
				makeDetail({
					claims: [makeClaim({ evidenceIds: ["missing"] })],
				}),
			),
		).toThrow("INVALID_EVIDENCE_REFERENCE");
		expect(() =>
			projectResearchResult(
				makeDetail({
					candidates: [
						{
							id: "candidate",
							type: "knowledge",
							text: "dangling",
							claimIds: ["missing"],
							adoption: "pending",
						},
					],
				}),
			),
		).toThrow("INVALID_CANDIDATE_CLAIM_REFERENCE");
	});

	test("capabilities report only the implemented web boundary", () => {
		const capabilities = buildDeepStillCapabilities();
		expect(capabilities.operations).toEqual([]);
		expect(capabilities.sourceKinds).toEqual(["web"]);
		expect(capabilities.locatorKinds).toEqual([
			"web-url+snapshot-sha256+utf8-bytes",
		]);
		expect(capabilities.optionalHostCapabilities).not.toContain(
			"source_connector",
		);
		expect(capabilities.optionalHostCapabilities).toEqual(["knowledge_read"]);
	});

	test("repository identity is read only from explicit job metadata", () => {
		expect(
			repositoryIdentityFromConfig({
				repositoryIdentity: {
					projectRef: "project-1",
					repoPath: "/workspace/deepStill",
				},
			}),
		).toEqual({
			projectRef: "project-1",
			repoKey: undefined,
			repoPath: "/workspace/deepStill",
		});
		expect(
			repositoryIdentityFromConfig({ repoPath: "/implicit" }),
		).toBeUndefined();
		expect(() =>
			repositoryIdentityFromConfig({
				repositoryIdentity: { repoPath: "relative/path" },
			}),
		).toThrow("INVALID_REPOSITORY_IDENTITY");
	});

	test("episode projection rejects missing immutable events", () => {
		expect(() =>
			projectResearchResult(
				makeDetail({
					artifacts: [makeArtifact({ memoryId: "memory:v1" })],
					memory: [makeMemory({ events: [] })],
				}),
			),
		).toThrow("INVALID_EPISODE_EVENT_REFERENCE");
		expect(() =>
			projectResearchResult(
				makeDetail({
					artifacts: [makeArtifact({ memoryId: "memory:v1" })],
					memory: [
						makeMemory({
							events: [
								{
									...makeMemory().events[0],
									data: { altered: true },
								},
							],
						}),
					],
				}),
			),
		).toThrow("INVALID_EPISODE_EVENT_REFERENCE");
	});

	test("failed jobs without verified evidence do not expose a result", () => {
		const job = makeJob({ status: "failed", reason: "provider_error" });
		const projection = projectResearchResult(
			makeDetail({
				job,
				claims: [],
				evidence: [],
				candidates: [],
				artifacts: [makeArtifact({ claimIds: [], sections: undefined })],
			}),
		);
		expect(projection.execution.resultAvailable).toBe(false);
	});
});
