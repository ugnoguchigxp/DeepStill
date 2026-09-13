import { expect, test } from "vitest";
import { createLlmFetch } from "llm-fetch";
import { pdfText, isPdfResponse } from "../packages/crawler/pdf";
import { pdfLayout } from "../packages/crawler/pdf-layout";
import {
	alignPdfMetadata,
	pdfEvidencePages,
	pdfEvidenceUrl,
	pdfReadNotice,
} from "../packages/core/pdf";
import { locateEvidence } from "../packages/core";
import { fixtureCrawler, hash } from "../packages/crawler";
import { sourceIndex, readSourceRange } from "../packages/memory/source";
import { paperPdf } from "./helpers/pdf-fixture";
const signal = () => new AbortController().signal;
const sentence = "Measurements preserve the exact original numerical results.";

test("two-column paper reads down each column and preserves footer", async () => {
	const lines = [
		{
			text: "A paper heading spans the entire page width",
			x: 50,
			y: 740,
			size: 22,
		},
		...Array.from({ length: 4 }, (_, i) => [
			{
				text: `Left ${i + 1}: detailed research evidence.`,
				x: 50,
				y: 680 - i * 18,
			},
			{
				text: `Right ${i + 1}: separate research result.`,
				x: 330,
				y: 680 - i * 18,
			},
		]).flat(),
		{ text: "Journal footer 1", x: 50, y: 25 },
	];
	const parsed = await pdfText(paperPdf([{ lines }]), signal());
	expect(parsed.pageMap[0].layout).toBe("two-column");
	expect(parsed.text.indexOf("Left 4")).toBeLessThan(
		parsed.text.indexOf("Right 1"),
	);
	expect(parsed.text.indexOf("heading")).toBeLessThan(
		parsed.text.indexOf("Left 1"),
	);
	expect(parsed.text.endsWith("Journal footer 1")).toBe(true);
});

test("Japanese text and multi-page citations survive the real content guard", async () => {
	const parsed = await pdfText(
		paperPdf([
			{ lines: [{ text: sentence }] },
			{
				lines: [
					{ text: "日本語の研究結果を保存します。測定値は１２３です。🌿" },
				],
			},
		]),
		signal(),
	);
	const client = createLlmFetch({
		fetcher: async (url) => ({
			requestedUrl: url,
			finalUrl: url,
			status: 200,
			contentType: "text/plain",
			headers: { "content-type": "text/plain; charset=utf-8" },
			body: new TextEncoder().encode(parsed.text),
		}),
	});
	try {
		const doc = await client.read({
			url: "https://example.org/paper.pdf",
			maxCharacters: 100000,
			requestedUse: "extract_facts",
		});
		const source = {
			...(await fixtureCrawler.crawl(doc.finalUrl, signal())),
			text: doc.text,
			hash: hash(doc.text),
			pdf: alignPdfMetadata(
				{ ...parsed, rawHash: "fixture" },
				parsed.text,
				doc.text,
			),
		};
		expect(source.pdf.warnings).not.toContain("PDF_POSITION_UNAVAILABLE");
		const quote = "日本語の研究結果を保存します。測定値は１２３です。🌿";
		const evidence = locateEvidence(source, quote);
		expect(source.text.slice(evidence.start, evidence.end)).toBe(quote);
		expect(pdfEvidencePages(source, evidence.start, evidence.end)).toEqual([2]);
		expect(pdfEvidenceUrl(source, evidence.start, evidence.end)).toBe(
			`${doc.finalUrl}#page=2`,
		);
		expect(pdfEvidencePages(source, 0, source.text.length)).toEqual([1, 2]);
		expect(sourceIndex(source).pdf?.pageMap).toHaveLength(2);
		expect(readSourceRange(source, source.hash, evidence).pages).toEqual([2]);
	} finally {
		await client.close();
	}
});

test("mixed scanned, blank and vector pages cannot be mistaken for complete text", async () => {
	const parsed = await pdfText(
		paperPdf([
			{ lines: [{ text: sentence }] },
			{ image: true },
			{},
			{ image: true, lines: [{ text: sentence }] },
			{ vector: true },
		]),
		signal(),
	);
	expect(parsed.pageMap.map((p) => p.status)).toEqual([
		"extracted",
		"unread",
		"blank",
		"partial",
		"unread",
	]);
	expect(parsed.pageMap[1].warnings).toContain("VISUAL_CONTENT_UNREAD");
	expect(parsed.pageMap[1].start).toBe(parsed.pageMap[1].end);
	expect(parsed.coverage).toBe("partial");
	expect(pdfReadNotice({ ...parsed, rawHash: "fixture" })).toContain("2, 4, 5");
	await expect(
		pdfText(paperPdf([{ image: true }]), signal()),
	).rejects.toMatchObject({
		code: "PDF_NO_EXTRACTABLE_TEXT",
		pdf: { coverage: "unread", pageMap: [{ page: 1, status: "unread" }] },
	});
});

test("page and text limits retain evidence and explicitly record unprocessed pages", async () => {
	const pages = await pdfText(
		paperPdf(
			Array.from({ length: 101 }, () => ({ lines: [{ text: sentence }] })),
		),
		signal(),
	);
	expect(pages.pages).toBe(101);
	expect(pages.pageMap).toHaveLength(100);
	expect(pages.omittedPages).toEqual([
		{ from: 101, to: 101, reason: "PDF_PAGE_LIMIT" },
	]);
	const long = await pdfText(
		paperPdf(
			Array.from({ length: 80 }, () => ({
				lines: Array.from({ length: 30 }, (_, i) => ({
					text: sentence,
					y: 730 - i * 18,
				})),
			})),
		),
		signal(),
	);
	expect(long.text.length).toBeLessThanOrEqual(100000);
	expect(long.text.length).toBeGreaterThan(99000);
	expect(long.pageMap.at(-1)?.warnings).toContain("PDF_TEXT_LIMIT");
	expect(long.omittedPages.at(-1)?.to).toBe(80);
	expect(long.coverage).toBe("partial");
});

test("guard truncation maps only retained text and transformed text never gets guessed positions", async () => {
	const parsed = await pdfText(
		paperPdf([
			{ lines: [{ text: sentence }] },
			{ lines: [{ text: sentence }] },
		]),
		signal(),
	);
	const meta = { ...parsed, rawHash: "fixture" };
	const retained = parsed.text.slice(0, parsed.pageMap[1].start + 10);
	const aligned = alignPdfMetadata(meta, parsed.text, retained);
	expect(aligned.pageMap?.[1]).toMatchObject({
		end: retained.length,
		status: "partial",
		warnings: ["SNAPSHOT_TEXT_LIMIT"],
	});
	const lost = alignPdfMetadata(meta, parsed.text, sentence);
	expect(lost.pageMap?.[1].status).toBe("unread");
	const changed = alignPdfMetadata(meta, parsed.text, "unrelated text");
	expect(changed.pageMap).toBeUndefined();
	expect(pdfReadNotice(changed)).toContain("対応は未確認");
	const legacy = await fixtureCrawler.crawl(
		"https://example.org/paper",
		signal(),
	);
	legacy.pdf = { rawHash: "old", pages: 2 };
	expect(pdfEvidencePages(legacy, 0, 20)).toEqual([]);
	expect(pdfEvidencePages(legacy, -1, 5)).toEqual([]);
	expect(pdfReadNotice(legacy.pdf)).toBe("");
});

test("table cells, unsupported text direction and encoding problems remain explicit", async () => {
	const table = await pdfText(
		paperPdf([
			{
				lines: [50, 220, 400].flatMap((x, i) => [
					{ x, y: 700, text: `Column ${i + 1}` },
					{ x, y: 680, text: `Value ${i + 1}: 123.45 kg` },
				]),
			},
		]),
		signal(),
	);
	expect(table.pageMap[0].layout).toBe("uncertain");
	expect(table.pageMap[0].warnings).toContain("TABLE_LAYOUT_UNVERIFIED");
	expect(table.text.indexOf("Column 3")).toBeLessThan(
		table.text.indexOf("Value 1"),
	);
	const item = {
		str: "縦書きです",
		transform: [12, 0, 0, 12, 20, 700],
		width: 60,
		height: 12,
		dir: "ttb",
	};
	expect(pdfLayout([item], 612, 792)).toMatchObject({
		layout: "uncertain",
		warnings: ["UNSUPPORTED_TEXT_DIRECTION"],
	});
	const broken = await pdfText(
		paperPdf([{ lines: [{ text: `� ${sentence}` }] }]),
		signal(),
	);
	expect(broken.pageMap[0].warnings).toContain("TEXT_ENCODING_UNCERTAIN");
	await expect(
		pdfText(new TextEncoder().encode("not a PDF"), signal()),
	).rejects.toThrow();
});

test("PDF signatures handle mislabeled downloads without trusting filename or HTML mentions", () => {
	const bytes = paperPdf([{ lines: [{ text: sentence }] }]);
	expect(isPdfResponse("text/html", bytes)).toBe(true);
	expect(isPdfResponse("application/octet-stream", bytes)).toBe(true);
	expect(isPdfResponse("APPLICATION/PDF; charset=binary", bytes)).toBe(true);
	expect(
		isPdfResponse("text/html", new TextEncoder().encode("<p>%PDF-1.4</p>")),
	).toBe(false);
});

test("rotated pages and short text are explicitly unverified", async () => {
	const parsed = await pdfText(
		paperPdf([{ rotate: 90, lines: [{ text: "Short text" }] }]),
		signal(),
	);
	expect(parsed.pageMap[0]).toMatchObject({
		status: "partial",
		layout: "uncertain",
	});
	expect(parsed.pageMap[0].warnings).toEqual(
		expect.arrayContaining(["UNSUPPORTED_TEXT_DIRECTION", "LOW_TEXT_COVERAGE"]),
	);
});

test("PDF page citations and unread coverage survive artifact export", async () => {
	const { makeDetail } = await import("./helpers/fixtures");
	const { exportArtifact } = await import("../packages/artifact");
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const detail = makeDetail();
	const source = detail.sources[0];
	source.pdf = {
		rawHash: "fixture",
		pages: 3,
		coverage: "partial",
		pageMap: [
			{
				page: 2,
				start: 0,
				end: source.text.length,
				method: "embedded-text",
				status: "extracted",
				layout: "single-column",
				warnings: [],
			},
		],
		omittedPages: [{ from: 3, to: 3, reason: "PDF_PAGE_LIMIT" }],
	};
	const root = mkdtempSync(join(tmpdir(), "pdf-export-"));
	try {
		const dir = exportArtifact(detail, detail.artifacts[0], root);
		const html = readFileSync(join(dir, "report.html"), "utf8");
		expect(html).toContain("PDF p. 2");
		expect(html).toContain("#page=2");
		expect(html).toContain("3–3ページ");
		const markdown = readFileSync(join(dir, "report.md"), "utf8");
		expect(markdown).toContain("PDF p. 2");
		expect(markdown).toContain("上限で未取得");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("full-width section headings split column bands and footnotes remain after the body", async () => {
	const parsed = await pdfText(
		paperPdf([
			{
				lines: [
					...Array.from({ length: 3 }, (_, i) => [
						{
							text: `Upper left ${i}: detailed observation.`,
							x: 50,
							y: 720 - i * 18,
						},
						{
							text: `Upper right ${i}: detailed observation.`,
							x: 330,
							y: 720 - i * 18,
						},
					]).flat(),
					{
						text: "The next section spans both columns clearly",
						x: 50,
						y: 650,
						size: 22,
					},
					...Array.from({ length: 3 }, (_, i) => [
						{
							text: `Lower left ${i}: detailed observation.`,
							x: 50,
							y: 620 - i * 18,
						},
						{
							text: `Lower right ${i}: detailed observation.`,
							x: 330,
							y: 620 - i * 18,
						},
					]).flat(),
					{
						text: "Footnote: experimental conditions apply.",
						x: 50,
						y: 120,
						size: 8,
					},
				],
			},
		]),
		signal(),
	);
	const labels = [
		"Upper left 2",
		"Upper right 0",
		"The next section",
		"Lower left 2",
		"Lower right 0",
		"Footnote",
	];
	for (let i = 1; i < labels.length; i++)
		expect(parsed.text.indexOf(labels[i - 1])).toBeLessThan(
			parsed.text.indexOf(labels[i]),
		);
});

test("two-cell numeric tables are not silently declared single-column prose", async () => {
	const parsed = await pdfText(
		paperPdf([
			{
				lines: [
					{ text: "Group", x: 50, y: 700 },
					{ text: "Mass", x: 330, y: 700 },
					{ text: "A", x: 50, y: 680 },
					{ text: "123.45 kg", x: 330, y: 680 },
				],
			},
		]),
		signal(),
	);
	expect(parsed.pageMap[0].layout).toBe("uncertain");
	expect(parsed.text).toContain("123.45 kg");
});
