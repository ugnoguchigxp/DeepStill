import { pdfText } from "./pdf";
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
		],
	});
	const pdfSources = new Map<string, { rawHash: string; pages: number }>();
	return {
		async crawl(url, signal) {
			if (!client) {
				const { playwrightRetriever } = await import("llm-fetch/playwright");
				client = createLlmFetch({
					retrieval: { maxWireBytes: 10000000, maxDecodedBytes: 10000000 },
					contextGuard: { maxSegments: 4096, maxCharacters: 2000000 },
					fetcher: async (url, input) => {
						const raw = await safeFetch(url, input);
						if (raw.contentType.toLowerCase().startsWith("application/pdf")) {
							const rawHash = new Bun.CryptoHasher("sha256")
								.update(raw.body)
								.digest("hex");
							const parsed = await pdfText(
								raw.body,
								input?.signal || new AbortController().signal,
							);
							pdfSources.set(raw.finalUrl, { rawHash, pages: parsed.pages });
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
						const converted = transcodeLegacyHtml(raw);
						if (converted.encoding)
							decoding.set(raw.finalUrl, {
								encoding: converted.encoding,
								rawHash: new Bun.CryptoHasher("sha256")
									.update(raw.body)
									.digest("hex"),
							});
						return converted.result;
					},
					browser: {
						retriever: playwrightRetriever({ concurrency: 1 }),
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
			return {
				...doc,
				author: null,
				publishedAt: null,
				id: uid(),
				hash: hash(doc.text),
				extractor: pdfSources.has(doc.finalUrl)
					? "unpdf@1.8.1 + llm-fetch@0.1.0"
					: "llm-fetch@0.1.0",
				pdf: pdfSources.get(doc.finalUrl),
				decoding: decoding.get(doc.finalUrl),
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
