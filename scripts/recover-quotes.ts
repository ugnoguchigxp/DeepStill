import { Store, uid } from "../packages/db";
import {
	claimResponse,
	type Claim,
	type Evidence,
} from "../packages/contracts";
import { locateEvidence, normalize } from "../packages/core";
const store = new Store();
const id = process.argv[2];
const detail = store.detail(id);
if (!detail) throw new Error("JOB_MISSING");
let added = 0;
store.atomic(() => {
	for (const source of detail.sources) {
		const invocation = store.record<{ text: string }>(
			id,
			"invocation",
			source.id,
		);
		if (!invocation) continue;
		const parsed = claimResponse.safeParse(JSON.parse(invocation.text));
		if (!parsed.success) continue;
		for (const item of parsed.data.claims) {
			if (item.relation !== "supports" || item.confidence < 0.6) continue;
			if (
				store
					.all<Claim>(id, "claim")
					.some((c) => normalize(c.text) === normalize(item.text))
			)
				continue;
			try {
				const location = locateEvidence(source, item.quote);
				const evidence: Evidence = {
					id: uid(),
					snapshotId: source.id,
					...location,
				};
				const claim: Claim = {
					id: uid(),
					text: item.text,
					evidenceIds: [evidence.id],
					confidence: item.confidence,
					kind: "NEW",
					accepted: true,
					reason:
						"保存済み応答の再検証：空白の差のみを一意に解決し原文位置を保存",
					relatedClaimIds: [],
				};
				store.put(id, "evidence", evidence.id, evidence);
				store.put(id, "claim", claim.id, claim);
				added++;
				store.event(id, "claim.recovered", {
					claimId: claim.id,
					sourceId: source.id,
					method: "unique-whitespace-match",
				});
			} catch {
				/* ambiguous or unsupported quotes stay rejected */
			}
		}
	}
});
console.log(JSON.stringify({ id, added }));
store.close();
