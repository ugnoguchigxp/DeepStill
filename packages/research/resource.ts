import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "../contracts";
import {
	evidenceLocatorSchema,
	type EvidenceLocator,
} from "../source-connector/resource";

export * from "../source-connector/resource";

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function webResourceId(value: string) {
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			throw new Error("INVALID_WEB_RESOURCE_ID");
		return url.toString();
	} catch {
		throw new Error("INVALID_WEB_RESOURCE_ID");
	}
}

export function projectWebEvidence(
	source: Snapshot,
	evidence: Evidence,
	connectorInstanceId = "deepstill-web",
): EvidenceLocator {
	if (source.id !== evidence.snapshotId)
		throw new Error("EVIDENCE_SOURCE_MISMATCH");
	if (sha256(source.text) !== source.hash)
		throw new Error("SNAPSHOT_HASH_MISMATCH");
	if (
		!Number.isSafeInteger(evidence.start) ||
		!Number.isSafeInteger(evidence.end) ||
		evidence.start < 0 ||
		evidence.end < evidence.start ||
		evidence.end > source.text.length ||
		source.text.slice(evidence.start, evidence.end) !== evidence.quote
	)
		throw new Error("EVIDENCE_QUOTE_MISMATCH");
	const resourceId = webResourceId(source.finalUrl);
	return evidenceLocatorSchema.parse({
		resource: {
			connectorKind: "web",
			connectorInstanceId,
			resourceId,
			revision: `sha256:${source.hash}`,
			displayUrl: resourceId,
			visibilityRef: "unknown",
		},
		fragment: {
			kind: "utf8_bytes",
			value: {
				start: Buffer.byteLength(source.text.slice(0, evidence.start)),
				end: Buffer.byteLength(source.text.slice(0, evidence.end)),
				utf16Start: evidence.start,
				utf16End: evidence.end,
			},
		},
		snapshotHash: source.hash,
		quoteHash: sha256(evidence.quote),
	});
}
