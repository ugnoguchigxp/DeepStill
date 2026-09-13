import { expect, test } from "vitest";
import { metrics } from "../packages/core/metrics";
import { bestQuery, canonicalUrl, scoreQuery } from "../packages/core";
import { makeClaim, makeDetail, makeJob } from "./helpers/fixtures";

test("canonicalUrl strips tracking params and rejects credentials", () => {
	expect(
		canonicalUrl("https://example.org/path?utm_source=x&b=2&fbclid=1#hash"),
	).toBe("https://example.org/path?b=2");
	expect(() => canonicalUrl("https://user:pass@example.org/")).toThrow(
		"UNSUPPORTED_URL",
	);
	expect(canonicalUrl("http://example.org/")).toBe("http://example.org/");
});

test("scoreQuery and bestQuery prefer pending high scores", () => {
	expect(scoreQuery(0, "known", "balanced")).toBe(0);
	expect(scoreQuery(1, "verify", "diverse", 1)).toBe(100 - 0.01 - 12 - 15 + 3);
	expect(
		bestQuery([
			{
				id: "b",
				query: "beta",
				depth: 0,
				score: 10,
				reason: "",
				status: "pending",
				known: "explore",
			},
			{
				id: "a",
				query: "alpha",
				depth: 0,
				score: 10,
				reason: "",
				status: "pending",
				known: "explore",
			},
			{
				id: "c",
				query: "done",
				depth: 0,
				score: 99,
				reason: "",
				status: "searched",
				known: "explore",
			},
		])?.id,
	).toBe("a");
	expect(bestQuery([])).toBeUndefined();
});

test("metrics stay null without claims, decisions, tokens or requests", () => {
	const empty = makeDetail({
		job: makeJob({
			usage: {
				queries: 0,
				urls: 0,
				documents: 0,
				tokens: 0,
				requests: 0,
				costUsd: 0,
			},
		}),
		claims: [],
		candidates: [],
	});
	const m = metrics(empty);
	expect(m.fixture).toBe(true);
	expect(m.novelFindingRate).toBeNull();
	expect(m.duplicateRate).toBeNull();
	expect(m.knowledgeAdoptionRate).toBeNull();
	expect(m.adoptionDecisionCoverage).toBeNull();
	expect(m.tokenEfficiency).toBeNull();
	expect(m.searchEfficiency).toBeNull();
	const mixed = makeDetail({
		claims: [
			makeClaim({ kind: "NEW" }),
			makeClaim({ id: "c2", kind: "DUPLICATE", accepted: false }),
		],
		candidates: [
			{
				id: "k1",
				type: "knowledge",
				text: "a",
				claimIds: [],
				adoption: "pending",
			},
			{
				id: "k2",
				type: "knowledge",
				text: "b",
				claimIds: [],
				adoption: "accepted",
			},
			{
				id: "e1",
				type: "episode",
				text: "c",
				claimIds: [],
				adoption: "rejected",
			},
		],
	});
	const filled = metrics(mixed);
	expect(filled.novelFindingRate).toBe(0.5);
	expect(filled.duplicateRate).toBe(0.5);
	expect(filled.knowledgeAdoptionRate).toBe(1);
	expect(filled.adoptionDecisionCoverage).toBe(0.5);
	expect(filled.tokenEfficiency).toBeGreaterThan(0);
	expect(filled.searchEfficiency).toBeGreaterThan(0);
});
