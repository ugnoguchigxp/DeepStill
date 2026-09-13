import type { PdfMetadata, Snapshot } from "../contracts";

/** Only attach positions when the guarded snapshot is an unchanged prefix. */
export function alignPdfMetadata(
	pdf: PdfMetadata,
	extracted: string,
	saved: string,
): PdfMetadata {
	if (!extracted.startsWith(saved))
		return {
			...pdf,
			coverage: "partial",
			pageMap: undefined,
			warnings: [...(pdf.warnings ?? []), "PDF_POSITION_UNAVAILABLE"],
		};
	const pageMap = pdf.pageMap?.map((page) => {
		if (page.end <= saved.length) return page;
		return {
			...page,
			start: Math.min(page.start, saved.length),
			end: Math.min(page.end, saved.length),
			status:
				page.start < saved.length ? ("partial" as const) : ("unread" as const),
			warnings: [...page.warnings, "SNAPSHOT_TEXT_LIMIT"],
		};
	});
	return {
		...pdf,
		pageMap,
		coverage: !saved
			? "unread"
			: saved.length < extracted.length
				? "partial"
				: pdf.coverage,
	};
}
export function pdfEvidencePages(
	source: Snapshot,
	start: number,
	end: number,
): number[] {
	if (start < 0 || end <= start || end > source.text.length) return [];
	return (
		source.pdf?.pageMap
			?.filter((p) => p.start < end && p.end > start && p.end > p.start)
			.map((p) => p.page) ?? []
	);
}
export function pdfEvidenceUrl(source: Snapshot, start: number, end: number) {
	const pages = pdfEvidencePages(source, start, end);
	return pages.length
		? `${source.finalUrl.split("#")[0]}#page=${pages[0]}`
		: source.finalUrl;
}
export function pdfReadNotice(pdf?: PdfMetadata) {
	if (!pdf?.coverage) return "";
	const affected =
		pdf.pageMap
			?.filter((p) => p.status === "partial" || p.status === "unread")
			.map((p) => p.page) ?? [];
	const omitted = pdf.omittedPages?.map((p) => `${p.from}–${p.to}`) ?? [];
	return pdf.coverage === "text-extracted"
		? "PDFの埋め込み文字を抽出済み（図表・数式の意味は未検証）。"
		: `PDFに未読・未確認部分があります。${affected.length ? ` 対象ページ: ${affected.join(", ")}。` : ""}${omitted.length ? ` 上限で未取得: ${omitted.join(", ")}ページ。` : ""}${pdf.warnings?.includes("PDF_POSITION_UNAVAILABLE") ? " 本文とページ位置の対応は未確認です。" : ""} OCR・図表の画像解析は未実施です。`;
}
