/** Conservative horizontal layout recovery. No OCR, semantic rewriting or dehyphenation. */
export interface PdfTextItem {
	str: string;
	transform: number[];
	width: number;
	height: number;
	dir?: string;
	hasEOL?: boolean;
}
interface Line {
	x: number;
	y: number;
	right: number;
	size: number;
	text: string;
}
export const normalizePdfText = (text: string) =>
	text
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\f\v ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

export function pdfLayout(
	items: PdfTextItem[],
	width: number,
	height: number,
	rotation = 0,
) {
	const visible = items.filter((i) => i.str.trim());
	const uncertain =
		rotation % 360 !== 0 ||
		visible.some(
			(i) =>
				i.dir === "ttb" ||
				i.dir === "rtl" ||
				!i.transform.every(Number.isFinite) ||
				Math.abs(i.transform[1]) > 0.1 ||
				Math.abs(i.transform[2]) > 0.1 ||
				i.transform[0] <= 0 ||
				i.transform[3] <= 0,
		);
	if (uncertain)
		return {
			text: normalizePdfText(
				items.map((i) => `${i.str}${i.hasEOL ? "\n" : " "}`).join(""),
			),
			layout: "uncertain" as const,
			warnings: ["UNSUPPORTED_TEXT_DIRECTION"],
		};
	const sizes = visible
		.map((i) => Math.abs(i.height) || 12)
		.sort((a, b) => a - b);
	const size = sizes[Math.floor(sizes.length / 2)] || 12;
	const rows: PdfTextItem[][] = [];
	for (const item of [...visible].sort(
		(a, b) =>
			b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
	)) {
		const row = rows.at(-1);
		if (row && Math.abs(row[0].transform[5] - item.transform[5]) <= size * 0.3)
			row.push(item);
		else rows.push([item]);
	}
	let tableLike = false;
	let splitRows = 0;
	const lines: Line[] = [];
	for (const row of rows) {
		row.sort((a, b) => a.transform[4] - b.transform[4]);
		let line: Line | undefined;
		let segments = 0;
		for (const item of row) {
			const x = item.transform[4];
			if (!line || x - line.right > Math.max(size * 1.8, width * 0.025)) {
				line = {
					x,
					y: item.transform[5],
					right: x + item.width,
					size: item.height,
					text: item.str,
				};
				lines.push(line);
				segments++;
			} else {
				const gap = x - line.right;
				const cjk =
					/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(
						line.text,
					) &&
					/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
						item.str,
					);
				line.text += `${gap > size * 0.15 && !cjk ? " " : ""}${item.str}`;
				line.right = Math.max(line.right, x + item.width);
			}
		}
		if (segments >= 3) tableLike = true;
		if (segments >= 2) splitRows++;
	}
	// Preserve marginal material, but keep it out of the flow between body columns.
	const marginal = lines.filter(
		(l) =>
			l.y > height * 0.94 ||
			l.y < height * 0.06 ||
			(l.y < height * 0.23 && l.size < size * 0.8),
	);
	const marginalSet = new Set(marginal);
	const body = lines.filter((l) => !marginalSet.has(l));
	const join = (ls: Line[]) => ls.map((l) => l.text).join("\n");
	let split: number | undefined;
	let splitCost = Number.POSITIVE_INFINITY;
	if (!tableLike) {
		// Both columns need several substantial lines. Headings spanning the gutter
		// are separators, never cut in half. Short rows may be a table, not prose.
		for (const ratio of [0.5, 0.45, 0.55]) {
			const x = width * ratio;
			const left = body.filter((l) => l.right < x - size * 0.5);
			const right = body.filter((l) => l.x > x + size * 0.5);
			const substantial = (ls: Line[]) =>
				ls.filter((l) => l.text.length >= 20).length >= 3;
			if (
				substantial(left) &&
				substantial(right) &&
				Math.min(left[0].y, right[0].y) >
					Math.max(left.at(-1)?.y ?? 0, right.at(-1)?.y ?? 0)
			) {
				const crossings = body.filter((l) => l.x < x && l.right >= x).length;
				if (crossings < splitCost) {
					split = x;
					splitCost = crossings;
				}
			}
		}
	}
	const ambiguous = tableLike || (split === undefined && splitRows >= 2);
	const ordered: string[] = [];
	if (split !== undefined) {
		let band: Line[] = [];
		const flush = () => {
			ordered.push(
				join(band.filter((l) => l.right < (split ?? 0))),
				join(band.filter((l) => l.right >= (split ?? 0))),
			);
			band = [];
		};
		for (const line of body) {
			if (line.x < split && line.right >= split) {
				flush();
				ordered.push(line.text);
			} else band.push(line);
		}
		flush();
	} else ordered.push(join(body));
	ordered.unshift(join(marginal.filter((l) => l.y > height * 0.94)));
	ordered.push(join(marginal.filter((l) => l.y <= height * 0.94)));
	return {
		text: normalizePdfText(ordered.filter(Boolean).join("\n\n")),
		layout: ambiguous
			? ("uncertain" as const)
			: split === undefined
				? ("single-column" as const)
				: ("two-column" as const),
		warnings: ambiguous ? ["TABLE_LAYOUT_UNVERIFIED"] : [],
	};
}
