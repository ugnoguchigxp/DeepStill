import type { Artifact, JobDetail } from "../contracts";
export const escapeHtml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
export function narrativeHtml(a: Artifact) {
	const sections =
		a.sections
			?.map(
				(s) =>
					`<section><h2>${escapeHtml(s.title)}</h2>${s.paragraphs.map((p) => `<p>${escapeHtml(p.text)} ${p.claimIds.map((id) => `<a href="#claim-${escapeHtml(id)}">[${a.claimIds.indexOf(id) + 1}]</a>`).join(" ")}</p>`).join("")}</section>`,
			)
			.join("") || "";
	return (
		sections +
		(
			[
				["この調査の限界", a.limitations],
				["残された問い", a.openQuestions],
			] as const
		)
			.map(([title, items]) =>
				items?.length
					? `<h2>${title}</h2><ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
					: "",
			)
			.join("")
	);
}
const mdText = (text: string) =>
	escapeHtml(text).replace(/([[\]`\\])/g, "\\$1");
export function narrativeMarkdown(a: Artifact, d: JobDetail) {
	const body =
		a.sections
			?.map(
				(s) =>
					`## ${mdText(s.title)}\n\n${s.paragraphs.map((p) => `${mdText(p.text)} ${p.claimIds.map((id) => `[${a.claimIds.indexOf(id) + 1}]`).join(" ")}`).join("\n\n")}`,
			)
			.join("\n\n") || a.body;
	const notes = (
		[
			["この調査の限界", a.limitations],
			["残された問い", a.openQuestions],
		] as const
	)
		.map(([title, items]) =>
			items?.length
				? `## ${title}\n\n${items.map((t) => `- ${mdText(t)}`).join("\n")}`
				: "",
		)
		.join("\n\n");
	const grouped = new Map<
		string,
		{ title: string; url: string; refs: number[] }
	>();
	a.claimIds.forEach((id, i) => {
		const c = d.claims.find((c) => c.id === id);
		const e = d.evidence.find((e) => e.id === c?.evidenceIds[0]);
		const source = d.sources.find((s) => s.id === e?.snapshotId);
		if (!source) throw new Error("INVALID_EVIDENCE_REFERENCE");
		const group = grouped.get(source.finalUrl) || {
			title: source.title,
			url: source.finalUrl,
			refs: [],
		};
		group.refs.push(i + 1);
		grouped.set(source.finalUrl, group);
	});
	const sources = [...grouped.values()]
		.map(
			(source) =>
				`${source.refs.map((n) => `[${n}]`).join(" ")} [${mdText(source.title)}](${source.url.replaceAll("(", "%28").replaceAll(")", "%29")})`,
		)
		.join("\n\n");

	return `# ${mdText(a.title)}\n\n${a.fixture ? "動作検証用fixtureです。\n\n" : ""}${body}\n\n${notes}\n\n## 出典\n\n${sources}\n`;
}
