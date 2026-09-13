import { expect, test } from "vitest";
import { sameSource } from "../packages/research/source-identity";
test("withheld paper aliases are recognized without fetching their content", () => {
	expect(
		sameSource(
			{ url: "https://ar5iv.labs.arxiv.org/html/1606.03126" },
			{ url: "https://arxiv.org/pdf/1606.03126v2.pdf" },
		),
	).toBe(true);
	expect(
		sameSource(
			{
				url: "https://example.com/one",
				title: "[PDF] Key-Value Memory Networks for Directly Reading Documents",
			},
			{
				url: "https://author.org/paper.pdf",
				title: "Key Value Memory Networks for Directly Reading Documents",
			},
		),
	).toBe(true);
	expect(
		sameSource(
			{ url: "https://arxiv.org/abs/1606.03126" },
			{ url: "https://arxiv.org/abs/2203.02985" },
		),
	).toBe(false);
	expect(
		sameSource(
			{ url: "https://example.com/a", title: "Memory" },
			{ url: "https://example.com/b", title: "Memory" },
		),
	).toBe(false);
	expect(
		sameSource(
			{ url: "https://example.com/a" },
			{ url: "https://example.com/a" },
		),
	).toBe(true);
});
