import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../packages/db";
const target = process.argv[2];
if (!target || existsSync(target))
	throw new Error("Provide a new backup file path");
const store = new Store();
store.sql.run("VACUUM INTO ?", [resolve(target)]);
store.close();
const copy = new Store(target);
const check = copy.sql.query("PRAGMA integrity_check").get() as {
	integrity_check: string;
};
copy.close();
if (check.integrity_check !== "ok")
	throw new Error("Backup integrity check failed");
console.log(`Verified backup: ${target}`);
