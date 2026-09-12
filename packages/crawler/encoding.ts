import type { SafeFetchResult } from "llm-fetch";
/** Decode declared legacy HTML before the unchanged content guard and text extractor. */
export function transcodeLegacyHtml(result: SafeFetchResult) {
	if (!/^(text\/html|application\/xhtml\+xml)/i.test(result.contentType))
		return { result, encoding: null };
	const header = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(
		result.headers["content-type"] || result.contentType,
	)?.[1];
	const prefix = new TextDecoder("windows-1252").decode(
		result.body.slice(0, 4096),
	);
	const meta = /<meta\b[^>]*charset\s*=\s*["']?([^;"'\s/>]+)/i.exec(
		prefix,
	)?.[1];
	const encoding = (header || meta || "").toLowerCase();
	if (
		![
			"iso-8859-1",
			"windows-1252",
			"shift_jis",
			"shift-jis",
			"sjis",
			"windows-31j",
			"euc-jp",
			"iso-2022-jp",
		].includes(encoding)
	)
		return { result, encoding: null };
	const decoded = new TextDecoder(encoding, { fatal: true }).decode(
		result.body,
	);
	const body = new TextEncoder().encode(`\uFEFF${decoded}`);
	return {
		result: {
			...result,
			body,
			contentType: "text/html",
			headers: {
				...result.headers,
				"content-type": "text/html; charset=utf-8",
			},
		},
		encoding,
	};
}
