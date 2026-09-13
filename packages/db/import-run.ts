import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Job } from "../contracts";
import { terminal } from "../core";
import type { Store } from "./index";
/** Import settled runs without rewriting the event IDs referenced by saved Memory. */
export function importRun(store: Store, path: string) {
	if (resolve(store.path) === resolve(path)) throw Error("SAME_DATABASE");
	const source = new Database(path, { readonly: true });
	try {
		const jobs = source.query("SELECT id,data FROM jobs").all() as {
			id: string;
			data: string;
		}[];
		if (!jobs.length) throw Error("NO_JOBS");
		if (
			jobs.some((j) => !terminal((JSON.parse(j.data) as Job).status)) ||
			source.query("SELECT 1 FROM execution_slot WHERE state != 'idle'").get()
		)
			throw Error("RUN_NOT_SETTLED");
		const hash = createHash("sha256").update(source.serialize()).digest("hex");
		return store.atomic(() => {
			for (const job of jobs) {
				if (store.getJob(job.id)) throw Error("JOB_ALREADY_EXISTS");
				store.sql
					.query("INSERT INTO jobs(id,data) VALUES(?,?)")
					.run(job.id, job.data);
				for (const table of ["records", "research_work_items"]) {
					const rows = source
						.query(`SELECT * FROM ${table} WHERE job_id=?`)
						.all(job.id) as Record<string, string | number | null>[];
					for (const row of rows) {
						const keys = Object.keys(row);
						store.sql
							.query(
								`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
							)
							.run(...keys.map((k) => row[k]));
					}
				}
				const events = source
					.query("SELECT * FROM events WHERE job_id=? ORDER BY id")
					.all(job.id) as {
					id: number;
					type: string;
					data: string;
					created_at: number;
				}[];
				for (const e of events)
					store.put(job.id, "imported_event", String(e.id), {
						id: e.id,
						jobId: job.id,
						type: e.type,
						data: JSON.parse(e.data),
						createdAt: e.created_at,
					});
				const max = Math.max(0, ...events.map((e) => e.id));
				// Future native events must not collide with the imported per-job IDs.
				if (
					!store.sql
						.query("SELECT 1 FROM sqlite_sequence WHERE name='events'")
						.get()
				)
					store.sql
						.query("INSERT INTO sqlite_sequence(name,seq) VALUES('events',?)")
						.run(max);
				else
					store.sql
						.query(
							"UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='events'",
						)
						.run(max);
				store.put(job.id, "import_origin", "origin", {
					id: "origin",
					source: resolve(path),
					sourceHash: hash,
					importedAt: new Date().toISOString(),
					execution:
						"Imported completed evaluation; not executed through WebUI",
					originalEventIdsPreserved: true,
				});
			}
			return jobs.map((j) => j.id);
		});
	} finally {
		source.close();
	}
}
