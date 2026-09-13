import { expect, test, vi } from "vitest";
let mode: "loading" | "getPage" | "getText" = "loading";
let destroy: ReturnType<typeof vi.fn>;
let opened = false;
const sentence =
	"A successfully decoded page retains its exact research evidence.";
vi.mock("unpdf", () => ({
	getResolvedPDFJS: async () => ({
		OPS: {},
		getDocument: () => {
			opened = true;
			let rejectLoading: ((error: Error) => void) | undefined;
			destroy = vi.fn(async () => {
				rejectLoading?.(new Error("loading cancelled"));
			});
			return {
				destroy,
				promise:
					mode === "loading"
						? new Promise((_resolve, reject) => {
								rejectLoading = reject;
							})
						: Promise.resolve({
								numPages: 3,
								getPage: async (i: number) => {
									if (mode === "getPage" && i === 2)
										throw new Error("broken page object");
									return {
										rotate: 0,
										getTextContent: async () => {
											if (mode === "getText" && i === 2)
												throw new Error("broken content stream");
											return {
												items: [
													{
														str: sentence,
														transform: [12, 0, 0, 12, 50, 700],
														width: 400,
														height: 12,
													},
												],
											};
										},
										getViewport: () => ({ width: 612, height: 792 }),
										getOperatorList: async () => ({ fnArray: [] }),
										getAnnotations: async () => [],
										cleanup: vi.fn(),
									};
								},
							}),
			};
		},
	}),
}));
import { pdfText } from "../packages/crawler/pdf";

test("cancellation during document loading destroys the task without waiting for a document", async () => {
	mode = "loading";
	opened = false;
	const controller = new AbortController();
	const pending = pdfText(new Uint8Array(), controller.signal);
	const rejected = expect(pending).rejects.toThrow("loading cancelled");
	await vi.waitFor(() => expect(opened).toBe(true));
	controller.abort();
	await rejected;
	expect(destroy).toHaveBeenCalled();
});

test.each([
	"getPage",
	"getText",
] as const)("a %s failure records an unread middle page and continues", async (failure) => {
	mode = failure;
	const result = await pdfText(new Uint8Array(), new AbortController().signal);
	expect(result.text).toBe(`${sentence}\n\n${sentence}`);
	expect(result.pageMap.map((p) => p.status)).toEqual([
		"extracted",
		"unread",
		"extracted",
	]);
	expect(result.pageMap[1].warnings).toContain("PDF_PAGE_PARSE_FAILED");
	expect(result.coverage).toBe("partial");
	expect(destroy).toHaveBeenCalledOnce();
});
