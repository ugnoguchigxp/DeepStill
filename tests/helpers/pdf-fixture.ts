/** Generated, redistributable PDF fixtures with explicit coordinates and Unicode mapping. */
export interface PdfFixturePage {
	lines?: { text: string; x?: number; y?: number; size?: number }[];
	image?: boolean;
	vector?: boolean;
	rotate?: number;
}
export function paperPdf(pages: PdfFixturePage[]) {
	const objects: string[] = [
		"",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const stream = (body: string) =>
		`<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
	const unicode = [
		...new Set(
			pages.flatMap((p) => p.lines?.flatMap((l) => [...l.text]) ?? []),
		),
	];
	const hex = (s: string) =>
		Array.from({ length: s.length }, (_, i) =>
			s.charCodeAt(i).toString(16).padStart(4, "0"),
		).join("");
	const cmap = add(
		stream(
			`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /TestUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${unicode.length} beginbfchar\n${unicode.map((c, i) => `<${(i + 1).toString(16).padStart(4, "0")}> <${hex(c)}>`).join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`,
		),
	);
	const descendant = add(
		"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
	);
	const font = add(
		`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmap} 0 R >>`,
	);
	const ids: number[] = [];
	for (const page of pages) {
		const body =
			(page.lines ?? [])
				.map((l, index) => {
					const ascii = /^[\x20-\x7E]*$/.test(l.text);
					const text = ascii
						? `(${l.text.replace(/[\\()]/g, "\\$&")})`
						: `<${[...l.text].map((c) => (unicode.indexOf(c) + 1).toString(16).padStart(4, "0")).join("")}>`;
					return `BT /${ascii ? "F1" : "F2"} ${l.size ?? 12} Tf 1 0 0 1 ${l.x ?? 50} ${l.y ?? 720 - index * 18} Tm ${text} Tj ET`;
				})
				.join("\n") +
			(page.image
				? "\nq 300 0 0 300 50 300 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF0000> EI Q"
				: "") +
			(page.vector ? "\n50 200 m 400 200 l S" : "");
		const content = add(stream(body));
		ids.push(
			add(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${page.rotate ?? 0} /Resources << /Font << /F1 3 0 R /F2 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
			),
		);
	}
	objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[1] = `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] /Count ${ids.length} >>`;
	let result = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((o, i) => {
		offsets.push(result.length);
		result += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = result.length;
	result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new TextEncoder().encode(result);
}
