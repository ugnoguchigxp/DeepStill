/** Identify known aliases before retrieval; never inspect withheld content to do so. */
export function sameSource(
	a: { url: string; title?: string },
	b: { url: string; title?: string },
) {
	const paperId = (url: string) => {
		const parsed = new URL(url);
		if (!/(^|\.)(arxiv\.org|ar5iv\.labs\.arxiv\.org)$/.test(parsed.hostname))
			return null;
		return (
			parsed.pathname.match(
				/\/(?:abs|html|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/,
			)?.[1] ?? null
		);
	};
	const title = (value?: string) =>
		(value ?? "")
			.normalize("NFKC")
			.toLowerCase()
			.replace(/^\s*\[pdf\]\s*/, "")
			.replace(/[^\p{L}\p{N}]/gu, "");
	const ta = title(a.title);
	return (
		a.url === b.url ||
		(!!paperId(a.url) && paperId(a.url) === paperId(b.url)) ||
		(ta.length >= 24 && ta === title(b.title))
	);
}
