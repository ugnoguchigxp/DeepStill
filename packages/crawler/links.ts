import { JSDOM } from "jsdom";
import type { Snapshot } from "../contracts";
import { canonicalUrl } from "../core";
/** Extract navigation only from an allowed document; callers never expose denied HTML. */
export function htmlNavigation(
	html: string,
	url: string,
): Pick<Snapshot, "links" | "headings"> {
	const dom = new JSDOM(html, { url });
	try {
		const document = dom.window.document;
		for (const node of document.querySelectorAll(
			'script,style,footer,header,nav,aside,[hidden],[aria-hidden="true"]',
		))
			node.remove();
		const root =
			document.querySelector("main,article,[role=main]") ?? document.body;
		const seen = new Set<string>();
		const links: NonNullable<Snapshot["links"]> = [];
		let section = "";
		for (const node of root.querySelectorAll("h1,h2,h3,h4,a[href]")) {
			if (node.tagName !== "A") {
				section = node.textContent?.trim() ?? "";
				continue;
			}
			const raw = node.getAttribute("href") ?? "";
			if (!raw || raw.startsWith("#")) continue;
			let target: URL;
			try {
				target = new URL(raw, url);
			} catch {
				continue;
			}
			if (
				!["https:", "http:"].includes(target.protocol) ||
				target.username ||
				target.password
			)
				continue;
			const href = canonicalUrl(target.href),
				text = (node.textContent ?? "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 200);
			if (!text || href === canonicalUrl(url) || seen.has(href)) continue;
			seen.add(href);
			links.push({
				url: href,
				text,
				context: (node.parentElement?.textContent ?? text)
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 600),
				section,
				kind:
					/next|次[の章節頁ペ]|続き|続く/i.test(text) ||
					node.getAttribute("rel") === "next"
						? "continuation"
						: "reference",
			});
		}
		return {
			links: links.slice(0, 400),
			headings: [...root.querySelectorAll("h1,h2,h3,h4")]
				.map((n) => n.textContent?.trim() ?? "")
				.filter(Boolean)
				.slice(0, 100),
		};
	} finally {
		dom.window.close();
	}
}
