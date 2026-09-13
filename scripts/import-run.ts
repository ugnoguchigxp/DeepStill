import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../packages/db";
import { importRun } from "../packages/db/import-run";
const [source, target = "data/deepstill.sqlite"] = process.argv.slice(2);
if (!source) throw Error("Usage: import-run.ts SOURCE_DB [TARGET_DB]");
const store = new Store(target);
try {
	if (!store.ready()) throw Error("TARGET_NOT_MIGRATED");
	mkdirSync("data/backups", { recursive: true });
	const backup = join("data/backups", `before-import-${Date.now()}.sqlite`);
	writeFileSync(backup, store.sql.serialize());
	console.info(JSON.stringify({ backup, jobIds: importRun(store, source) }));
} finally {
	store.close();
}
