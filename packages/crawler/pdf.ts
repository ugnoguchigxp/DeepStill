import { getDocumentProxy } from "unpdf";
/** Read text only; PDF actions, scripts and rendering are never executed. */
export async function pdfText(bytes: Uint8Array, signal: AbortSignal) {
	signal.throwIfAborted();
	const pdf = await getDocumentProxy(new Uint8Array(bytes), {
		useSystemFonts: false,
		disableFontFace: true,
	});
	const abort = () => {
		void pdf.loadingTask.destroy();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (pdf.numPages > 100) throw new Error("PDF_PAGE_LIMIT");
		const pages: string[] = [];
		let length = 0;
		for (let i = 1; i <= pdf.numPages; i++) {
			signal.throwIfAborted();
			const page = await pdf.getPage(i);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) =>
					"str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
				)
				.join("");
			length += text.length;
			if (length > 200000) throw new Error("PDF_TEXT_LIMIT");
			pages.push(text);
			page.cleanup();
		}
		const text = pages.join("\n\n").trim();
		if (text.length < 40) throw new Error("PDF_NO_EXTRACTABLE_TEXT");
		return { text, pages: pdf.numPages };
	} finally {
		signal.removeEventListener("abort", abort);
		await pdf.loadingTask.destroy();
	}
}
