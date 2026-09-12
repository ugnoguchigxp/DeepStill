import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/db";
const dir = mkdtempSync(join(tmpdir(), "deepstill-e2e-"));
const db = join(dir, "test.sqlite");
const store = new Store(db);
store.migrate();
store.close();
const build = Bun.spawnSync(["bun", "run", "build"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (build.exitCode) process.exit(build.exitCode);
const env = {
	...process.env,
	PORT: "4319",
	DATABASE_URL: db,
	ARTIFACT_ROOT: join(dir, "artifacts"),
};
const children = ["api", "worker"].map((s) =>
	Bun.spawn(["bun", "run", s], { env, stdout: "inherit", stderr: "inherit" }),
);
const stop = () => {
	for (const c of children) c.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((c) => c.exited));
stop();
await Promise.all(children.map((c) => c.exited));
rmSync(dir, { recursive: true, force: true });
