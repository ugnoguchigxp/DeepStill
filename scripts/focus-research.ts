import type { Query } from "../packages/contracts";
import { normalize, terminal } from "../packages/core";
import { Store, uid } from "../packages/db";

const store = new Store();
const id = process.argv[2];
const queries = process.argv.slice(3);
const job = store.getJob(id);
if (!job || terminal(job.status) || !queries.length)
	throw new Error("ACTIVE_JOB_AND_QUERIES_REQUIRED");
if (job.config.engineVersion === 2) {
	for (const question of queries)
		store.addExploration(
			id,
			uid(),
			store.research(id).revision,
			question,
			"supplement",
		);
	console.log(JSON.stringify({ id, focusQueries: queries }));
	store.close();
	process.exit(0);
}
store.atomic(() => {
	for (const text of queries) {
		const query = normalize(text);
		if (store.all<Query>(id, "query").some((q) => q.query === query)) continue;
		const item: Query = {
			id: uid(),
			query,
			depth: 1,
			score: 99,
			reason: "quality-review: coverage gap; explicit operator focus",
			status: "pending",
			known: "unverified",
		};
		store.put(id, "query", item.id, item);
		store.event(id, "query.focus_added", {
			id: item.id,
			query,
			reason: item.reason,
		});
	}
});
console.log(JSON.stringify({ id, focusQueries: queries }));
store.close();
