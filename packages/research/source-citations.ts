import { locateEvidence } from "../core";
import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "../contracts";
import type { Citation } from "./world-model-schema";

export { citationSchema, type Citation } from "./world-model-schema";

export function sourceLines(text: string) {
	const result: { number: number; start: number; end: number; text: string }[] =
		[];
	let start = 0,
		end = 0,
		bytes = 0;
	for (const char of text) {
		end += char.length;
		bytes += Buffer.byteLength(char);
		if (char === "\n" || bytes >= 1200) {
			result.push({
				number: result.length + 1,
				start,
				end,
				text: text.slice(start, end),
			});
			start = end;
			bytes = 0;
		}
	}
	if (end > start)
		result.push({
			number: result.length + 1,
			start,
			end,
			text: text.slice(start, end),
		});
	return result;
}

export function resolveCitations(
	citations: Citation[],
	sources: Snapshot[],
): Evidence[] {
	const evidence: Evidence[] = [];
	for (const citation of citations) {
		const source = sources.find((item) => item.id === citation.sourceId);
		if (
			!source ||
			createHash("sha256").update(source.text).digest("hex") !== source.hash
		)
			throw Error("INVALID_SOURCE_REFERENCE");
		let located: ReturnType<typeof locateEvidence>;
		try {
			if ("quote" in citation) located = locateEvidence(source, citation.quote);
			else {
				const lines = sourceLines(source.text),
					first = lines[citation.firstLine - 1],
					last = lines[citation.lastLine - 1];
				if (!first || !last || last.end <= first.start)
					throw Error("INVALID_LINE_REFERENCE");
				located = {
					start: first.start,
					end: last.end,
					quote: source.text.slice(first.start, last.end),
					context: source.text.slice(
						Math.max(0, first.start - 120),
						last.end + 120,
					),
				};
			}
		} catch {
			throw Error(
				`QUOTE_NOT_IN_SNAPSHOT: ${source.id}: ${JSON.stringify(citation).slice(0, 350)}. Copy a contiguous passage without ellipses.`,
			);
		}
		const id = `e:${createHash("sha256")
			.update(`${source.id}:${located.start}:${located.quote}`)
			.digest("hex")
			.slice(0, 24)}`;
		if (!evidence.some((item) => item.id === id))
			evidence.push({ id, snapshotId: source.id, ...located });
	}
	return evidence;
}
