import { expect, test } from "vitest";
import { hash } from "../packages/crawler";
import {
	applySectionUpdate,
	type Draft,
	draftSectionCatalog,
} from "../packages/research/deliverables";
import { evaluateDeliverableReplay } from "../packages/research/replay-evaluation";

const source = {
	id: "source-1",
	url: "https://example.com/source",
	finalUrl: "https://example.com/source",
	title: "Source",
	text: "Mechanism A is used.\nCondition B applies.",
	hash: "",
	contentType: "text/plain",
	fetchedAt: new Date(0).toISOString(),
	fetchMethod: "fixture",
	author: null,
	publishedAt: null,
	extractor: "fixture",
	characterCount: 42,
	truncated: false,
	security: {
		trust: "untrusted",
		tainted: false,
		guard: "fixture",
		findings: [],
		assurance: "low",
		decision: "allow",
		reasons: [],
		limitations: [],
	},
	fixture: true,
};
source.hash = hash(source.text);

const previous: Draft = {
	sections: [
		{
			title: "Mechanism",
			paragraphs: [
				{
					text: "Mechanism A is used.",
					kind: "finding",
					citations: [{ sourceId: source.id, firstLine: 1, lastLine: 1 }],
				},
			],
		},
	],
	knowledge: [],
	limitations: [],
	openQuestions: ["Condition"],
};

test("fixed-source replay reports valid retention without network research", () => {
	const result = evaluateDeliverableReplay(
		previous,
		{
			draft: {
				...previous,
				sections: [
					...previous.sections,
					{
						title: "Condition",
						paragraphs: [
							{
								text: "Condition B applies.",
								kind: "finding",
								citations: [{ sourceId: source.id, firstLine: 2, lastLine: 2 }],
							},
						],
					},
				],
				openQuestions: [],
			},
			next: { kind: "finish", satisfied: true, reason: "Covered" },
		},
		[source],
		"job",
		"topic",
	);
	expect(result.valid).toBe(true);
	expect(result.retention).toMatchObject({
		exactParagraphs: 1,
		totalPreviousParagraphs: 1,
		rate: 1,
		droppedSectionTitles: [],
	});
	expect(result.candidate).toMatchObject({
		sections: 2,
		paragraphs: 2,
		claims: 2,
	});
});

test("fixed-source replay exposes dropped sections and invalid citations", () => {
	const dropped = evaluateDeliverableReplay(
		previous,
		{
			draft: { ...previous, sections: [] },
			next: { kind: "finish", satisfied: false, reason: "No evidence" },
		},
		[source],
		"job",
		"topic",
	);
	expect(dropped.valid).toBe(true);
	expect(dropped.retention.droppedSectionTitles).toEqual(["Mechanism"]);

	const invalid = evaluateDeliverableReplay(
		previous,
		{
			draft: {
				...previous,
				sections: [
					{
						...previous.sections[0],
						paragraphs: [
							{
								...previous.sections[0].paragraphs[0],
								citations: [{ sourceId: "missing", firstLine: 1, lastLine: 1 }],
							},
						],
					},
				],
			},
			next: { kind: "finish", satisfied: true, reason: "Covered" },
		},
		[source],
		"job",
		"topic",
	);
	expect(invalid.valid).toBe(false);
	expect(invalid.error).toContain("INVALID_SOURCE_REFERENCE");
});

test("section updates preserve omitted sections and require explicit valid targets", () => {
	const second: Draft["sections"][number] = {
		title: "Condition",
		paragraphs: [
			{
				text: "Condition B is still unresolved.",
				kind: "inference",
				citations: [{ sourceId: source.id, firstLine: 2, lastLine: 2 }],
			},
		],
	};
	const initial = { ...previous, sections: [...previous.sections, second] };
	const catalog = draftSectionCatalog(initial);
	const replacement: Draft["sections"][number] = {
		...second,
		paragraphs: [
			{
				text: "Condition B applies.",
				kind: "finding",
				citations: [{ sourceId: source.id, firstLine: 2, lastLine: 2 }],
			},
		],
	};
	const result = applySectionUpdate(initial, {
		sections: [
			{
				operation: "replace",
				sectionId: catalog[1].sectionId,
				section: replacement,
			},
		],
		knowledge: [],
		limitations: [],
		openQuestions: [],
	});
	expect(result.sections[0]).toEqual(initial.sections[0]);
	expect(result.sections[1]).toEqual(replacement);
	expect(() =>
		applySectionUpdate(initial, {
			sections: [
				{
					operation: "delete",
					sectionId: "missing",
					reason: "unsupported",
				},
			],
			knowledge: [],
			limitations: [],
			openQuestions: [],
		}),
	).toThrow("UNKNOWN_SECTION_REFERENCE");
});
