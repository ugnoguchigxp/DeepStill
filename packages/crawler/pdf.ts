import { getResolvedPDFJS } from "unpdf";
import type { PdfMetadata, PdfPage } from "../contracts";
import { pdfLayout } from "./pdf-layout";

export interface PdfResult extends Omit<PdfMetadata, "rawHash"> {
	text: string;
	pageMap: PdfPage[];
	omittedPages: NonNullable<PdfMetadata["omittedPages"]>;
}
/** Trust a bounded PDF signature, not the URL extension. */
export function isPdfResponse(contentType: string, bytes: Uint8Array) {
	return (
		contentType.toLowerCase().split(";", 1)[0].trim() === "application/pdf" ||
		/^\s*%PDF-\d\.\d/.test(new TextDecoder().decode(bytes.subarray(0, 1024)))
	);
}
/** Parse operators and embedded text only; no PDF actions, OCR or rendering. */
export async function pdfText(
	bytes: Uint8Array,
	signal: AbortSignal,
): Promise<PdfResult> {
	signal.throwIfAborted();
	const { getDocument, OPS } = await getResolvedPDFJS();
	signal.throwIfAborted();
	// Register cancellation before document loading, including password/parse failures.
	const task = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		disableFontFace: true,
		stopAtErrors: true,
	});
	const abort = () => {
		void task.destroy().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const pdf = await task.promise;
		const pageMap: PdfPage[] = [];
		const omittedPages: PdfResult["omittedPages"] = [];
		let text = "";
		for (let i = 1; i <= Math.min(pdf.numPages, 100); i++) {
			signal.throwIfAborted();
			if (text.length >= 100000) {
				omittedPages.push({
					from: i,
					to: pdf.numPages,
					reason: "PDF_TEXT_LIMIT",
				});
				break;
			}
			const record: PdfPage = {
				page: i,
				start: text.length,
				end: text.length,
				method: "embedded-text",
				status: "unread",
				layout: "uncertain",
				warnings: [],
			};
			pageMap.push(record);
			let page: Awaited<ReturnType<typeof pdf.getPage>> | undefined;
			try {
				page = await pdf.getPage(i);
				const content = await page.getTextContent();
				const viewport = page.getViewport({ scale: 1 });
				const parsed = pdfLayout(
					content.items.filter((item) => "str" in item),
					viewport.width,
					viewport.height,
					page.rotate,
				);
				record.layout = parsed.layout;
				record.warnings.push(...parsed.warnings);
				const ops = await page.getOperatorList();
				const painted = ops.fnArray.some((op) =>
					[
						OPS.paintSolidColorImageMask,
						OPS.paintImageXObject,
						OPS.paintInlineImageXObject,
						OPS.paintImageMaskXObject,
						OPS.paintImageXObjectRepeat,
						OPS.paintImageMaskXObjectRepeat,
						OPS.paintImageMaskXObjectGroup,
						OPS.paintInlineImageXObjectGroup,
						OPS.shadingFill,
						OPS.constructPath,
					].includes(op),
				);
				if (painted) record.warnings.push("VISUAL_CONTENT_UNREAD");
				if (parsed.text && parsed.text.replace(/\s/g, "").length < 40)
					record.warnings.push("LOW_TEXT_COVERAGE");
				if (/\uFFFD/.test(parsed.text))
					record.warnings.push("TEXT_ENCODING_UNCERTAIN");
				const annotations = await page.getAnnotations({ intent: "display" });
				if (annotations.some((a) => a.subtype !== "Link"))
					record.warnings.push("ANNOTATION_CONTENT_UNREAD");
				const separator = text && parsed.text ? "\n\n" : "";
				const available = Math.max(0, 100000 - text.length - separator.length);
				let chunk = parsed.text.slice(0, available).trimEnd();
				if (/[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
				if (chunk.length < parsed.text.length)
					record.warnings.push("PDF_TEXT_LIMIT");
				if (chunk) {
					text += separator;
					record.start = text.length;
					text += chunk;
					record.end = text.length;
				}
				record.status = chunk
					? record.warnings.length
						? "partial"
						: "extracted"
					: record.warnings.length
						? "unread"
						: "blank";
				if (record.warnings.includes("PDF_TEXT_LIMIT")) {
					if (i < pdf.numPages)
						omittedPages.push({
							from: i + 1,
							to: pdf.numPages,
							reason: "PDF_TEXT_LIMIT",
						});
					break;
				}
			} catch (error) {
				signal.throwIfAborted();
				record.warnings.push("PDF_PAGE_PARSE_FAILED");
				if (error instanceof Error && error.name === "PasswordException")
					throw error;
			} finally {
				page?.cleanup();
			}
		}
		if (pdf.numPages > 100 && !omittedPages.length)
			omittedPages.push({
				from: 101,
				to: pdf.numPages,
				reason: "PDF_PAGE_LIMIT",
			});
		signal.throwIfAborted();
		const result: PdfResult = {
			text,
			pages: pdf.numPages,
			pageMap,
			omittedPages,
			coverage: !text
				? "unread"
				: omittedPages.length ||
						pageMap.some((p) => p.status === "partial" || p.status === "unread")
					? "partial"
					: "text-extracted",
			warnings: [],
		};
		if (!text)
			throw Object.assign(new Error("PDF_NO_EXTRACTABLE_TEXT"), {
				code: "PDF_NO_EXTRACTABLE_TEXT",
				pdf: result,
			});
		return result;
	} finally {
		signal.removeEventListener("abort", abort);
		await task.destroy();
	}
}
