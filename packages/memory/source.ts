import { pdfEvidencePages, pdfReadNotice } from "../core/pdf";
import { createHash } from "node:crypto";
import type { Snapshot } from "../contracts";
export interface SourceRange {
	start: number;
	end: number;
}
/** UTF-16 boundaries never split a surrogate pair. Index previews are not evidence. */
export function sourceIndex(source: Snapshot, chunkBytes = 2400) {
	const preview = (start: number, end: number) =>
		[
			...new Set([
				start,
				Math.max(start, Math.floor((start + end) / 2) - 40),
				Math.max(start, end - 80),
			]),
		]
			.map((at) => source.text.slice(at, Math.min(end, at + 80)))
			.join(" … ");
	const ranges: (SourceRange & { preview: string; bytes: number })[] = [];
	let start = 0,
		bytes = 0,
		offset = 0;
	for (const char of source.text) {
		const size = Buffer.byteLength(char);
		if (bytes + size > chunkBytes && offset > start) {
			ranges.push({
				start,
				end: offset,
				preview: preview(start, offset),
				bytes,
			});
			start = offset;
			bytes = 0;
		}
		offset += char.length;
		bytes += size;
	}
	if (offset > start)
		ranges.push({
			start,
			end: offset,
			preview: preview(start, offset),
			bytes,
		});
	return {
		snapshotId: source.id,
		title: source.title,
		hash: source.hash,
		unit: "utf16" as const,
		length: source.text.length,
		...(source.pdf
			? { pdf: source.pdf, readingNotice: pdfReadNotice(source.pdf) }
			: {}),
		ranges,
	};
}
export function readSourceRange(
	source: Snapshot,
	hash: string,
	range: SourceRange,
	maxBytes = 12000,
	read: SourceRange[] = [],
) {
	const { start, end } = range;
	if (
		source.hash !== hash ||
		createHash("sha256").update(source.text).digest("hex") !== hash
	)
		throw Error("SOURCE_HASH_CHANGED");
	if (
		!Number.isInteger(start) ||
		!Number.isInteger(end) ||
		start < 0 ||
		end <= start ||
		end > source.text.length
	)
		throw Error("INVALID_SOURCE_RANGE");
	const boundary = (n: number) =>
		n === 0 ||
		n === source.text.length ||
		!(
			/[\uD800-\uDBFF]/.test(source.text[n - 1]) &&
			/[\uDC00-\uDFFF]/.test(source.text[n])
		);
	if (!boundary(start) || !boundary(end)) throw Error("SPLIT_SURROGATE");
	if (read.some((r) => start < r.end && end > r.start))
		throw Error("OVERLAPPING_SOURCE_RANGE");
	const text = source.text.slice(start, end);
	if (Buffer.byteLength(text) > maxBytes) throw Error("SOURCE_RANGE_LIMIT");
	return {
		snapshotId: source.id,
		hash,
		start,
		end,
		unit: "utf16" as const,
		text,
		...(source.pdf
			? {
					pages: pdfEvidencePages(source, start, end),
					readingNotice: pdfReadNotice(source.pdf),
				}
			: {}),
		bytes: {
			start: Buffer.byteLength(source.text.slice(0, start)),
			end: Buffer.byteLength(source.text.slice(0, end)),
		},
	};
}
