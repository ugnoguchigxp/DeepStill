import { pdfEvidencePages, pdfEvidenceUrl, pdfReadNotice } from "../core/pdf";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type Artifact,
	type Claim,
	type JobDetail,
	reportResponse,
} from "../contracts";
import { hash } from "../crawler";
import {
	assertStoredDiscoverySemantics,
	worldModelDiscoverySchema,
} from "../research/world-model-schema";
import { narrativeHtml, narrativeMarkdown } from "./narrative";
export function validateClaims(detail: JobDetail, claimIds: string[]) {
	for (const id of claimIds) {
		const claim = detail.claims.find((c) => c.id === id);
		if (!claim?.accepted || !claim.evidenceIds.length)
			throw new Error("INVALID_CLAIM_REFERENCE");
		for (const eid of claim.evidenceIds) {
			const e = detail.evidence.find((e) => e.id === eid);
			const s = detail.sources.find((s) => s.id === e?.snapshotId);
			if (
				!e ||
				!s ||
				s.text.slice(e.start, e.end) !== e.quote ||
				hash(s.text) !== s.hash
			)
				throw new Error("INVALID_EVIDENCE_REFERENCE");
		}
	}
}
export function validateArtifact(detail: JobDetail, artifact: Artifact) {
	if (
		!(
			artifact.evidenceUnavailable === true &&
			artifact.claimIds.length === 0 &&
			!artifact.sections &&
			artifact.body === "十分な根拠を取得できませんでした。" &&
			(artifact.limitations?.length ?? 0) > 0
		) &&
		!reportResponse.safeParse(artifact).success
	)
		throw new Error("INVALID_REPORT_RESPONSE");
	validateClaims(detail, artifact.claimIds);
	if (artifact.sections) {
		const refs = new Set(
			artifact.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.claimIds)),
		);
		if (
			refs.size !== new Set(artifact.claimIds).size ||
			artifact.claimIds.some((id) => !refs.has(id))
		)
			throw new Error("INVALID_REPORT_REFERENCE");
	}
	validateWorldModelDiscovery(detail, artifact);
}
export function validateWorldModelDiscovery(
	detail: JobDetail,
	artifact: Artifact,
) {
	if (!artifact.worldModelDiscovery) return;
	const discovery = worldModelDiscoverySchema.parse(
		artifact.worldModelDiscovery,
	);
	assertStoredDiscoverySemantics(discovery);
	if (discovery.basedOnArtifactVersion !== artifact.version)
		throw new Error("INVALID_DISCOVERY_ARTIFACT_VERSION");
	for (const candidate of discovery.candidates)
		for (const item of candidate.evidence)
			for (const id of item.evidenceIds) {
				const evidence = detail.evidence.find((entry) => entry.id === id);
				const source = detail.sources.find(
					(entry) => entry.id === evidence?.snapshotId,
				);
				if (
					!evidence ||
					!source ||
					source.text.slice(evidence.start, evidence.end) !== evidence.quote ||
					hash(source.text) !== source.hash
				)
					throw new Error("INVALID_DISCOVERY_EVIDENCE_REFERENCE");
			}
}
export function reportBody(claims: Claim[], fixture: boolean) {
	return `${fixture ? "検証用fixtureです。実際のWeb調査結果ではありません。\n\n" : ""}${claims.map((c) => `${c.text} [${c.id}]`).join("\n\n")}`;
}
const escapeHtml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
export function exportArtifact(
	detail: JobDetail,
	artifact: Artifact,
	root = "data/artifacts",
) {
	validateArtifact(detail, artifact);
	const parent = join(root, detail.job.id);
	const dir = join(parent, String(artifact.version));
	if (existsSync(dir)) {
		const previous = JSON.parse(
			readFileSync(join(dir, "evidence.json"), "utf8"),
		).artifact as Artifact;
		if (previous.id !== artifact.id) throw new Error("ARTIFACT_VERSION_EXISTS");
		const { qualityState: _oldQuality, ...oldContent } = previous;
		const { qualityState: _newQuality, ...newContent } = artifact;
		if (!isDeepStrictEqual(oldContent, newContent))
			throw new Error("IMMUTABLE_ARTIFACT_CHANGED");
		return dir;
	}
	mkdirSync(parent, { recursive: true });
	const content = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(artifact.title)}</title></head><body><article><h1>${escapeHtml(artifact.title)}</h1><p>${artifact.fixture ? "検証fixture / " : " "}終了理由: ${escapeHtml(detail.job.reason ?? "")}</p>${narrativeHtml(artifact)}<h2>根拠一覧</h2>${artifact.claimIds
		.map((id) => {
			const c = detail.claims.find((c) => c.id === id);
			if (!c) throw new Error("CLAIM_MISSING");
			return `<section id="claim-${id}"><h2>Claim ${id}</h2><p>${escapeHtml(c.text)}</p>${c.evidenceIds
				.map((eid) => {
					const e = detail.evidence.find((e) => e.id === eid);
					const s = detail.sources.find((s) => s.id === e?.snapshotId);
					if (!e || !s) throw new Error("SOURCE_MISSING");
					const pages = pdfEvidencePages(s, e.start, e.end);
					return `<blockquote id="evidence-${eid}">${escapeHtml(e.quote)}</blockquote><p>Snapshot: ${s.id} / UTF-16 [${e.start}, ${e.end}) / ${escapeHtml(s.fetchedAt)}${pages.length ? ` / PDF p. ${pages.join(", ")}` : ""}</p>${s.pdf?.coverage ? `<p>${escapeHtml(pdfReadNotice(s.pdf))}</p>` : ""}<p><a href="${escapeHtml(pdfEvidenceUrl(s, e.start, e.end))}" rel="noreferrer">${escapeHtml(s.title || s.finalUrl)}</a></p><details><summary>取得時の本文</summary><pre>${escapeHtml(s.text)}</pre></details>`;
				})
				.join("")}</section>`;
		})
		.join("")}</article></body></html>`;
	const staging = mkdtempSync(join(parent, ".artifact-"));
	try {
		writeFileSync(
			join(staging, "report.md"),
			narrativeMarkdown(artifact, detail),
		);
		writeFileSync(join(staging, "report.html"), content);
		if (artifact.memoryId) {
			const memory = detail.memory?.find((m) => m.id === artifact.memoryId);
			if (!memory) throw new Error("ARTIFACT_MEMORY_MISSING");
			writeFileSync(
				join(staging, "memory.json"),
				JSON.stringify(memory, null, 2),
			);
		}
		writeFileSync(
			join(staging, "evidence.json"),
			JSON.stringify(
				{
					artifact: { ...artifact, qualityState: undefined },
					sources: detail.sources,
					evidence: detail.evidence,
					claims: detail.claims,
				},
				null,
				2,
			),
		);
		// Versions are immutable. A completed directory appears in one rename.
		renameSync(staging, dir);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return dir;
}
