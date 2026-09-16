import type { Snapshot } from "../contracts";
import { type Draft, deliverableStepSchema, materialize } from "./deliverables";

export type ReplayEvaluation = {
	valid: boolean;
	error?: string;
	previous: {
		sections: number;
		paragraphs: number;
		characters: number;
		knowledge: number;
		openQuestions: number;
	};
	candidate: {
		sections: number;
		paragraphs: number;
		characters: number;
		knowledge: number;
		openQuestions: number;
		claims: number;
	};
	retention: {
		exactParagraphs: number;
		totalPreviousParagraphs: number;
		rate: number;
		droppedSectionTitles: string[];
	};
	next: unknown;
};

const metrics = (draft: Draft) => {
	const paragraphs = draft.sections.flatMap((section) => section.paragraphs);
	return {
		sections: draft.sections.length,
		paragraphs: paragraphs.length,
		characters: paragraphs.reduce(
			(total, paragraph) => total + paragraph.text.length,
			0,
		),
		knowledge: draft.knowledge.length,
		openQuestions: draft.openQuestions.length,
	};
};

export function evaluateDeliverableReplay(
	previous: Draft,
	rawOutput: unknown,
	sources: Snapshot[],
	jobId: string,
	topic: string,
): ReplayEvaluation {
	const before = metrics(previous);
	try {
		const output = deliverableStepSchema.parse(rawOutput);
		const draft = output.draft ?? previous;
		const result = materialize(draft, sources, jobId, 1, topic);
		const after = metrics(draft);
		const oldParagraphs = previous.sections.flatMap((section) =>
			section.paragraphs.map((paragraph) => paragraph.text),
		);
		const newParagraphs = new Set(
			draft.sections.flatMap((section) =>
				section.paragraphs.map((paragraph) => paragraph.text),
			),
		);
		const exactParagraphs = oldParagraphs.filter((text) =>
			newParagraphs.has(text),
		).length;
		const newTitles = new Set(draft.sections.map((section) => section.title));
		return {
			valid: true,
			previous: before,
			candidate: { ...after, claims: result.claims.length },
			retention: {
				exactParagraphs,
				totalPreviousParagraphs: oldParagraphs.length,
				rate: oldParagraphs.length ? exactParagraphs / oldParagraphs.length : 1,
				droppedSectionTitles: previous.sections
					.map((section) => section.title)
					.filter((title) => !newTitles.has(title)),
			},
			next: output.next,
		};
	} catch (error) {
		return {
			valid: false,
			error: String(error),
			previous: before,
			candidate: {
				sections: 0,
				paragraphs: 0,
				characters: 0,
				knowledge: 0,
				openQuestions: 0,
				claims: 0,
			},
			retention: {
				exactParagraphs: 0,
				totalPreviousParagraphs: before.paragraphs,
				rate: 0,
				droppedSectionTitles: previous.sections.map((section) => section.title),
			},
			next: null,
		};
	}
}
