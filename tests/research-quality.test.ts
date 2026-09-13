import { reviewSchema, reviewPass } from "../packages/artifact/quality";
import { transcodeLegacyHtml } from "../packages/crawler/encoding";
import { test, expect } from "vitest";
import { selectSections, locateEvidence } from "../packages/core";
import {
	strictSchema,
	groundedSchema,
	CODEX_MODEL,
	CODEX_REASONING,
} from "../packages/llm-provider/codex";
import { claimResponse, reportResponse } from "../packages/contracts";
import { z } from "zod";
test("oversized source paragraphs retain exact, bounded evidence passages", () => {
	const text = `preface\n\n${"宗教とLLMの研究資料。".repeat(900)}`;
	const passages = selectSections(text, "宗教 LLM", 6000);
	expect(passages.length).toBeGreaterThan(0);
	expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(
		6000,
	);
	expect(passages.some((p) => p.text.includes("宗教"))).toBe(true);
	for (const p of passages)
		expect(text.slice(p.start, p.start + p.text.length)).toBe(p.text);
});
test("Codex schemas require every property at every object level", () => {
	for (const source of [claimResponse, reportResponse]) {
		const schema = strictSchema(z.toJSONSchema(source));
		const check = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const object = value as Record<string, unknown>;
			if (object.type === "object") {
				expect(object.required).toEqual(
					Object.keys(object.properties as object),
				);
				expect(object.additionalProperties).toBe(false);
			}
			for (const item of Object.values(object)) check(item);
		};
		check(schema);
	}
	expect(CODEX_MODEL).toBe("gpt-5.6-luna");
	expect(CODEX_REASONING).toBe("low");
});

test("whitespace-only quote recovery stores original offsets and rejects ambiguous matches", () => {
	const source = {
		text: "Before. The models\nperform differently in Arabic. After.",
	} as import("../packages/contracts").Snapshot;
	const e = locateEvidence(source, "The models perform differently in Arabic.");
	expect(e.quote).toBe("The models\nperform differently in Arabic.");
	expect(source.text.slice(e.start, e.end)).toBe(e.quote);
	expect(() =>
		locateEvidence(
			{
				...source,
				text: "The models\nperform differently. The models\tperform differently.",
			},
			"The models perform differently.",
		),
	).toThrow();
	expect(() =>
		locateEvidence(source, "The models perform identically in Arabic."),
	).toThrow();
});

test("legacy HTML decoding preserves text and keeps UTF-8 metadata consistent", () => {
	const bytes = new Uint8Array([
		...new TextEncoder().encode('<meta charset="iso-8859-1"><p>caf'),
		233,
		...new TextEncoder().encode("</p>"),
	]);
	const input = {
		requestedUrl: "https://example.com/",
		finalUrl: "https://example.com/",
		status: 200,
		contentType: "text/html",
		body: bytes,
		headers: { "content-type": "text/html" },
	};
	const converted = transcodeLegacyHtml(input);
	expect(converted.encoding).toBe("iso-8859-1");
	expect(new TextDecoder().decode(converted.result.body)).toContain("café");
	expect(converted.result.contentType).toBe("text/html");
	expect(converted.result.headers["content-type"]).toBe(
		"text/html; charset=utf-8",
	);
	expect(input.body).toBe(bytes);
});

test("grounded synthesis schemas constrain nested citations to supplied IDs", () => {
	interface SchemaNode {
		properties: Record<string, SchemaNode>;
		items: SchemaNode;
		enum?: string[];
	}
	const schema = groundedSchema(
		"synthesize",
		JSON.stringify({ claims: [{ id: "known-one" }, { id: "known-two" }] }),
	) as unknown as SchemaNode;
	expect(schema.properties.claimIds.items.enum).toEqual([
		"known-one",
		"known-two",
	]);
	expect(
		schema.properties.sections.items.properties.paragraphs.items.properties
			.claimIds.items.enum,
	).toEqual(["known-one", "known-two"]);
});

test("review gate rejects a passing label with major issues or missing dimensions", () => {
	const review = reviewSchema.parse({
		scores: {
			scope: 5,
			support: 5,
			depth: 5,
			narrative: 5,
			readability: 5,
			knowledge: 5,
			episode: 5,
		},
		majorIssues: ["unsupported claim"],
		improvements: [],
		verdict: "pass",
	});
	expect(reviewPass(true, review)).toBe(false);
	expect(
		reviewSchema.safeParse({ ...review, scores: { support: 5 } }).success,
	).toBe(false);
	expect(reviewPass(true, { ...review, majorIssues: [] })).toBe(true);
});

test("Codex removes unsupported URI format but application validation remains separate", () => {
	const result = strictSchema({
		type: "object",
		properties: { url: { type: "string", format: "uri" } },
	}) as { properties: { url: Record<string, unknown> } };
	expect(result.properties.url.type).toBe("string");
	expect(result.properties.url.format).toBeUndefined();
});

test("declared Shift JIS HTML is converted without corrupting Japanese", () => {
	const prefix = new TextEncoder().encode(
		'<html><meta charset="shift_jis"><p>',
	);
	const suffix = new TextEncoder().encode("</p></html>");
	const body = new Uint8Array([
		...prefix,
		0x93,
		0xfa,
		0x96,
		0x7b,
		0x8c,
		0xea,
		...suffix,
	]);
	const base = {
		requestedUrl: "https://example.org",
		finalUrl: "https://example.org",
		status: 200,
		headers: { "content-type": "text/html" },
		contentType: "text/html",
		body,
	};
	const converted = transcodeLegacyHtml(base);
	expect(new TextDecoder().decode(converted.result.body)).toContain("日本語");
	expect(converted.encoding).toBe("shift_jis");
});

test("scope decisions must cover every item exactly once and carry a necessary question", async () => {
	const { parseScope } = await import("../packages/research/scope");
	const items = [
		{ id: "lossless", text: "WebP lossless" },
		{ id: "lossy", text: "lossy JPEG tuning" },
	];
	const decisions = [
		{
			id: "lossless",
			status: "in_scope",
			reason: "exact reconstruction",
			question: "How is exact reconstruction preserved?",
			query: "WebP lossless exact reconstruction",
		},
		{
			id: "lossy",
			status: "out_of_scope",
			reason: "lossy only",
			question: "",
			query: "",
		},
	];
	expect(parseScope(JSON.stringify({ decisions }), items)).toHaveLength(2);
	expect(() =>
		parseScope(JSON.stringify({ decisions: [decisions[0]] }), items),
	).toThrow("INVALID_SCOPE_COVERAGE");
	expect(() =>
		parseScope(
			JSON.stringify({ decisions: [decisions[0], decisions[0]] }),
			items,
		),
	).toThrow("INVALID_SCOPE_COVERAGE");
	expect(() =>
		parseScope(
			JSON.stringify({
				decisions: [{ ...decisions[0], question: "" }, decisions[1]],
			}),
			items,
		),
	).toThrow("SCOPE_QUESTION_REQUIRED");
});

test("quality cannot compensate a weak dimension with other perfect scores", async () => {
	const { reviewScore } = await import("../packages/artifact/quality");
	const review = reviewSchema.parse({
		scores: {
			scope: 5,
			support: 5,
			depth: 5,
			narrative: 5,
			readability: 5,
			knowledge: 5,
			episode: 4,
		},
		majorIssues: [],
		improvements: [],
		verdict: "pass",
	});
	expect(reviewScore(review)).toBe(99);
	expect(reviewPass(true, review)).toBe(false);
	expect(
		reviewPass(true, {
			...review,
			scores: { ...review.scores, episode: 5 },
			verdict: "revise",
		}),
	).toBe(false);
});

test("revised candidates retain historical adoption without leaking into the current version", async () => {
	const { reportCandidates, currentCandidates } = await import(
		"../packages/artifact/research"
	);
	const artifact = {
		id: "a2",
		version: 2,
		title: "可逆圧縮",
		body: "",
		claimIds: ["c2"],
		fixture: false,
		generatedAt: "2026-09-12",
		sections: [
			{
				title: "完全復元の条件",
				paragraphs: [
					{
						text: "対象は復号後の画素値。",
						kind: "finding" as const,
						claimIds: ["c2"],
					},
				],
			},
		],
	};
	const detail = {
		job: { topic: "可逆圧縮", reason: "budget_exhausted" },
		queries: [{ query: "lossless modes", status: "searched" }],
		events: [],
		claims: [],
	} as unknown as import("../packages/contracts").JobDetail;
	const candidates = reportCandidates(detail, artifact);
	const old = {
		id: "old",
		type: "knowledge" as const,
		text: "discarded claim",
		claimIds: ["c1"],
		artifactVersion: 1,
		adoption: "accepted" as const,
	};
	expect(currentCandidates([old, ...candidates], [artifact])).toEqual(
		candidates,
	);
	expect(old.adoption).toBe("accepted");
	expect(
		candidates.every(
			(c) => c.artifactVersion === 2 && c.claimIds.includes("c2"),
		),
	).toBe(true);
	expect(candidates[0].text).toContain("完全復元の条件");
	expect(candidates.at(-1)?.text).toContain("lossless modes");
	expect(
		currentCandidates([{ ...old, artifactVersion: undefined }], [artifact]),
	).toEqual([]);
});

test("revision filters legacy claims and rejects absent scope decisions without altering stored acceptance", async () => {
	const { filterResearchClaims } = await import("../packages/research/filter");
	const detail = {
		job: { topic: "可逆圧縮" },
		claims: [
			{ id: "lossless", text: "lossless", accepted: true, evidenceIds: [] },
			{ id: "near", text: "near-lossless", accepted: true, evidenceIds: [] },
		],
		evidence: [],
	} as unknown as import("../packages/contracts").JobDetail;
	const filtered = await filterResearchClaims(
		detail,
		{
			async complete() {
				return {
					text: JSON.stringify({
						decisions: [
							{
								id: "lossless",
								status: "in_scope",
								reason: "exact",
								question: "mechanism",
								query: "",
							},
							{
								id: "near",
								status: "out_of_scope",
								reason: "not exact",
								question: "",
								query: "",
							},
						],
					}),
					usage: 1,
					audit: {},
				};
			},
		},
		AbortSignal.timeout(1000),
	);
	expect(
		filtered.detail.claims.filter((c) => c.accepted).map((c) => c.id),
	).toEqual(["lossless"]);
	expect(detail.claims.every((c) => c.accepted)).toBe(true);
	expect(filtered.audits).toHaveLength(1);
});

test("revision takes current worker feedback from the ledger ahead of stale review files", async () => {
	const { revisionFeedback } = await import("../packages/artifact/research");
	const detail = {
		artifacts: [{ version: 2 }],
		qualityReviews: [
			{ version: 1, review: { majorIssues: ["old"] } },
			{
				version: 2,
				review: {
					majorIssues: ["missing mechanism"],
					improvements: ["read the primary source"],
				},
			},
		],
	} as unknown as import("../packages/contracts").JobDetail;
	expect(
		revisionFeedback(detail, { review: { majorIssues: ["stale file"] } })
			?.majorIssues,
	).toEqual(["missing mechanism"]);
	expect(
		revisionFeedback(
			{ ...detail, qualityReviews: [] },
			{ review: { majorIssues: ["legacy"] } },
		)?.majorIssues,
	).toEqual(["legacy"]);
});
