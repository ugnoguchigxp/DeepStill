import {
	readFileSync,
	writeFileSync,
	renameSync,
	readdirSync,
	existsSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function codeVersion() {
	const hash = new Bun.CryptoHasher("sha256");
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name))
				hash.update(path).update(readFileSync(path));
		}
	};
	walk(join(root, "packages"));
	walk(join(root, "apps/worker"));
	walk(join(root, "apps/api"));
	hash
		.update(readFileSync(join(root, "package.json")))
		.update(readFileSync(join(root, "bun.lock")));
	if (existsSync(join(root, ".env")))
		hash.update(String(statSync(join(root, ".env")).mtimeMs));
	return hash.digest("hex");
}
export interface WorkerHealth {
	pid: number;
	at: number;
	version: string;
}
export function publishWorker(db: string, version: string) {
	const path = `${db}.worker.json`;
	writeFileSync(
		`${path}.${process.pid}.tmp`,
		JSON.stringify({ pid: process.pid, at: Date.now(), version }),
	);
	renameSync(`${path}.${process.pid}.tmp`, path);
}
export function workerHealth(db: string, version = codeVersion()) {
	try {
		const state = JSON.parse(
			readFileSync(`${db}.worker.json`, "utf8"),
		) as WorkerHealth;
		return {
			ready: Date.now() - state.at < 6000 && state.version === version,
			stale: state.version !== version,
			...state,
		};
	} catch {
		return { ready: false, stale: false };
	}
}
