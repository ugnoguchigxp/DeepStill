import { canonicalUrl } from "../core";
import { htmlNavigation } from "./links";
import { pdfText, isPdfResponse, type PdfResult } from "./pdf";
import { alignPdfMetadata } from "../core/pdf";
import { transcodeLegacyHtml } from "./encoding";
import { createLlmFetch, createSafeHttpFetcher } from "llm-fetch";
import type { Snapshot } from "../contracts";
import { uid } from "../db";
export interface Crawler {
	crawl(url: string, signal: AbortSignal): Promise<Snapshot>;
	close(): Promise<void>;
}
export const hash = (text: string) =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");
// llm-fetch normalizes a response URL by removing its trailing slash.
const responseKey = (url: string) =>
	canonicalUrl(url).replace(/\/(?=[?#]|$)/, "");
export function liveCrawler(): Crawler {
	let client: ReturnType<typeof createLlmFetch> | undefined;
	const decoding = new Map<string, { encoding: string; rawHash: string }>();
	const safeFetch = createSafeHttpFetcher({
		maxWireBytes: 10000000,
		maxDecodedBytes: 10000000,
		allowedContentTypes: [
			"text/html",
			"application/xhtml+xml",
			"text/plain",
			"application/pdf",
			"application/octet-stream",
		],
	});
	const htmlSources = new Map<string, { html: string; baseUrl: string }>();
	const pdfSources = new Map<string, PdfResult & { rawHash: string }>();
	return {
		async crawl(url, signal) {
			if (!client) {
				const { playwrightRetriever } = await import("llm-fetch/playwright");
				const renderer = playwrightRetriever({ concurrency: 1 });
				client = createLlmFetch({
					retrieval: { maxWireBytes: 10000000, maxDecodedBytes: 10000000 },
					contextGuard: { maxSegments: 4096, maxCharacters: 2000000 },
					fetcher: async (url, input) => {
						const raw = await safeFetch(url, input);
						pdfSources.delete(responseKey(raw.finalUrl));
						if (isPdfResponse(raw.contentType, raw.body)) {
							const rawHash = new Bun.CryptoHasher("sha256")
								.update(raw.body)
								.digest("hex");
							const parsed = await pdfText(
								raw.body,
								input?.signal || new AbortController().signal,
							);
							if (pdfSources.size >= 32)
								pdfSources.delete(pdfSources.keys().next().value ?? "");
							pdfSources.set(responseKey(raw.finalUrl), {
								rawHash,
								...parsed,
							});
							return {
								...raw,
								body: new TextEncoder().encode(parsed.text),
								contentType: "text/plain",
								headers: {
									...raw.headers,
									"content-type": "text/plain; charset=utf-8",
								},
							};
						}
						if (
							raw.contentType
								.toLowerCase()
								.startsWith("application/octet-stream")
						)
							throw Object.assign(new Error("UNSUPPORTED_CONTENT_TYPE"), {
								code: "UNSUPPORTED_CONTENT_TYPE",
							});
						const converted = transcodeLegacyHtml(raw);
						if (converted.encoding)
							decoding.set(responseKey(raw.finalUrl), {
								encoding: converted.encoding,
								rawHash: new Bun.CryptoHasher("sha256")
									.update(raw.body)
									.digest("hex"),
							});
						if (/html/i.test(converted.result.contentType))
							htmlSources.set(responseKey(raw.finalUrl), {
								html: new TextDecoder().decode(converted.result.body),
								baseUrl: raw.finalUrl,
							});
						return converted.result;
					},
					browser: {
						retriever: {
							name: renderer.name,
							isAvailable: () =>
								renderer.isAvailable
									? renderer.isAvailable()
									: Promise.resolve(true),
							async retrieve(url, input) {
								const rendered = await renderer.retrieve(url, input);
								pdfSources.delete(responseKey(rendered.finalUrl));
								if (/html/i.test(rendered.contentType))
									htmlSources.set(responseKey(rendered.finalUrl), {
										html: new TextDecoder().decode(rendered.body),
										baseUrl: rendered.finalUrl,
									});
								return rendered;
							},
							close: () => renderer.close?.() ?? Promise.resolve(),
						},
						defaultRender: "auto",
					},
				});
			}
			const doc = await client.read({
				url,
				signal,
				maxCharacters: 100000,
				render: "auto",
				requestedUse: "extract_facts",
			});
			const parsed = pdfSources.get(responseKey(doc.finalUrl));
			const { text: extractedText = "", ...metadata } = parsed ?? {};
			const pdf = parsed
				? alignPdfMetadata(
						metadata as Omit<typeof parsed, "text">,
						extractedText,
						doc.text,
					)
				: undefined;
			const html = htmlSources.get(responseKey(doc.finalUrl));
			htmlSources.delete(responseKey(doc.finalUrl));
			return {
				...(html && doc.security.decision === "allow"
					? htmlNavigation(html.html, html.baseUrl)
					: {}),
				...doc,
				truncated:
					doc.truncated ||
					Boolean(
						pdf?.omittedPages?.length ||
							pdf?.pageMap?.some((p) =>
								p.warnings.some((w) => w.endsWith("TEXT_LIMIT")),
							),
					),
				author: null,
				publishedAt: null,
				id: uid(),
				hash: hash(doc.text),
				extractor: pdf
					? "unpdf@1.8.1/layout-v1 + llm-fetch@0.1.1"
					: "llm-fetch@0.1.1",
				pdf,
				decoding: decoding.get(responseKey(doc.finalUrl)),
				fixture: false,
			};
		},
		async close() {
			await client?.close();
		},
	};
}
export const fixtureCrawler: Crawler = {
	async crawl(url) {
		const text = url.includes("limits")
			? "Hard budgets limit the number of queries and fetched URLs.\n\nDurable leases let another worker recover an interrupted task."
			: "Immutable snapshots preserve the exact text used as evidence.\n\nA claim must reference a passage in an external source.";
		return {
			id: uid(),
			author: null,
			publishedAt: null,
			url,
			finalUrl: url,
			title: url.includes("limits") ? "Budget fixture" : "Research fixture",
			text,
			hash: hash(text),
			fetchedAt: new Date().toISOString(),
			fetchMethod: "fixture",
			truncated: false,
			security: { trust: "untrusted", decision: "allow" },
			extractor: "fixture-v1",
			fixture: true,
		};
	},
	async close() {},
};
