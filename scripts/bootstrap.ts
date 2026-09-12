import { copyFileSync, existsSync } from "node:fs";
if (!existsSync(".env")) copyFileSync(".env.example", ".env");
const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (install.exitCode) process.exit(install.exitCode);
const migration = Bun.spawnSync(["bun", "run", "db:migrate"], {
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(migration.exitCode);
