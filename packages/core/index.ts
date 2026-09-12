import type { Query, Snapshot } from "../contracts";
export const normalize = (text: string) =>
	text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function canonicalUrl(value: string) {
	const u = new URL(value);
	if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
		throw new Error("UNSUPPORTED_URL");
	u.hash = "";
	for (const key of [...u.searchParams.keys()])
		if (key.startsWith("utm_") || key === "fbclid") u.searchParams.delete(key);
	u.searchParams.sort();
	return u.toString();
}
export function scoreQuery(
	depth: number,
	known: string,
	strategy: string,
	index = 0,
) {
	return (
		100 -
		index * 0.01 -
		depth * 12 -
		(known === "known" ? 100 : known === "verify" ? 15 : 0) +
		(strategy === "diverse" ? (index % 3) * 3 : 0)
	);
}
export function bestQuery(queries: Query[]) {
	return queries
		.filter((q) => q.status === "pending")
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.query.localeCompare(b.query) ||
				a.id.localeCompare(b.id),
		)[0];
}
export function selectSections(text: string, topic: string, max = 6000) {
	const words = normalize(topic)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 2);
	const chunks = [...text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)]
		.flatMap((m) => {
			const parts = [];
			for (let offset = 0; offset < m[0].length; offset += 1600)
				parts.push({
					text: m[0].slice(offset, offset + 1600),
					start: m.index + offset,
				});
			return parts;
		})
		.map((m) => ({
			text: m.text,
			start: m.start,
			score: words.reduce(
				(n, w) => n + (normalize(m.text).includes(w) ? 1 : 0),
				0,
			),
		}))
		.sort((a, b) => b.score - a.score || a.start - b.start);
	let size = 0;
	return chunks
		.filter((c) => {
			if (size + c.text.length > max) return false;
			size += c.text.length;
			return true;
		})
		.sort((a, b) => a.start - b.start);
}
export function locateEvidence(source: Snapshot, quote: string) {
	let start = source.text.indexOf(quote),
		end = start + quote.length;
	if (quote.trim().length < 8) throw new Error("QUOTE_NOT_FOUND");
	if (start < 0) {
		// Accept only a unique whitespace-normalized match; preserve the original bytes and offsets.
		let normalized = "";
		const starts: number[] = [];
		const ends: number[] = [];
		for (let i = 0; i < source.text.length; ) {
			const from = i;
			const space = /\s/u.test(source.text[i]);
			if (space) {
				while (i < source.text.length && /\s/u.test(source.text[i])) i++;
				normalized += " ";
			} else {
				normalized += source.text[i];
				i++;
			}
			starts.push(from);
			ends.push(i);
		}
		const needle = quote.replace(/\s+/gu, " ").trim();
		const index = normalized.indexOf(needle);
		if (index < 0 || normalized.indexOf(needle, index + 1) >= 0)
			throw new Error("QUOTE_NOT_FOUND");
		start = starts[index];
		end = ends[index + needle.length - 1];
	}
	return {
		start,
		end,
		quote: source.text.slice(start, end),
		context: source.text.slice(Math.max(0, start - 120), end + 120),
	};
}
export const terminal = (status: string) =>
	["completed", "partial", "cancelled", "failed"].includes(status);
