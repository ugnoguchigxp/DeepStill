import { expect, test, vi } from "vitest";

const pdf = (text: string) => {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let result = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((o, i) => {
		offsets.push(result.length);
		result += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = result.length;
	result += "xref\n0 6\n0000000000 65535 f \n";
	result += offsets
		.slice(1)
		.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
		.join("");
	result += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new TextEncoder().encode(result);
};

let kind: "pdf" | "pdf-binary" | "binary" | "latin" | "html" = "html";
vi.mock("llm-fetch/playwright", () => ({
	playwrightRetriever: () => ({}),
}));
vi.mock("llm-fetch", () => ({
	createSafeHttpFetcher: () => async (url: string) => {
		if (kind === "binary")
			return {
				requestedUrl: url,
				finalUrl: url,
				status: 200,
				contentType: "application/octet-stream",
				body: new Uint8Array([0, 1, 2]),
				headers: {},
			};
		if (kind === "pdf" || kind === "pdf-binary")
			return {
				requestedUrl: url,
				finalUrl: url,
				status: 200,
				contentType:
					kind === "pdf-binary"
						? "application/octet-stream"
						: "application/pdf",
				body: pdf("Lossless compression reconstructs the exact original data."),
				headers: { "content-type": "application/pdf" },
			};
		if (kind === "latin")
			return {
				requestedUrl: url,
				finalUrl: url,
				status: 200,
				contentType: "text/html",
				body: new Uint8Array([
					...new TextEncoder().encode('<meta charset="iso-8859-1"><p>caf'),
					233,
					...new TextEncoder().encode("</p>"),
				]),
				headers: { "content-type": "text/html; charset=iso-8859-1" },
			};
		return {
			requestedUrl: url,
			finalUrl: `${url}/`,
			status: 200,
			contentType: "text/html",
			body: new TextEncoder().encode(
				'<main><h1>Paper</h1><p>Read the <a href="paper.pdf">full text</a>.</p></main>',
			),
			headers: { "content-type": "text/html; charset=utf-8" },
		};
	},
	createLlmFetch: ({
		fetcher,
	}: {
		fetcher: (
			url: string,
			input?: { signal?: AbortSignal },
		) => Promise<{
			finalUrl: string;
			body: Uint8Array;
			contentType: string;
		}>;
	}) => ({
		async read({ url, signal }: { url: string; signal?: AbortSignal }) {
			const raw = await fetcher(url, { signal });
			return {
				requestedUrl: url,
				finalUrl: raw.finalUrl.replace(/\/$/, ""),
				title: "fetched",
				text: new TextDecoder().decode(raw.body).replace("\uFEFF", ""),
				fetchedAt: new Date().toISOString(),
				fetchMethod: "http",
				truncated: false,
				security: { trust: "untrusted", decision: "allow" },
			};
		},
		async close() {},
	}),
}));

import { liveCrawler } from "../packages/crawler";

test("live crawler records PDF metadata and legacy HTML decoding", async () => {
	kind = "pdf";
	const crawler = liveCrawler();
	try {
		const pdfDoc = await crawler.crawl(
			"https://example.org/paper.pdf",
			new AbortController().signal,
		);
		expect(pdfDoc.extractor).toContain("unpdf");
		expect(pdfDoc.pdf?.pages).toBe(1);
		expect(pdfDoc.pdf?.pageMap?.[0]).toMatchObject({
			start: 0,
			end: pdfDoc.text.length,
		});
		kind = "pdf-binary";
		const binaryPdf = await crawler.crawl(
			"https://example.org/download",
			new AbortController().signal,
		);
		expect(binaryPdf.pdf?.pageMap?.[0].page).toBe(1);
		kind = "binary";
		await expect(
			crawler.crawl(
				"https://example.org/unknown",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_TYPE" });
		kind = "latin";
		const html = await crawler.crawl(
			"https://example.org/latin",
			new AbortController().signal,
		);
		expect(html.decoding?.encoding).toBe("iso-8859-1");
		kind = "html";
		const plain = await crawler.crawl(
			"https://example.org/ok",
			new AbortController().signal,
		);
		expect(plain.decoding).toBeUndefined();
		expect(plain.links?.[0]?.url).toBe("https://example.org/ok/paper.pdf");
		expect(plain.headings).toEqual(["Paper"]);
	} finally {
		await crawler.close();
	}
});
