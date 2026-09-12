export {};
const migration = Bun.spawnSync([process.execPath, "scripts/migrate.ts"], {
	stdout: "inherit",
	stderr: "inherit",
});
if (migration.exitCode) process.exit(migration.exitCode);
// Launch the actual processes, so stopping this supervisor cannot orphan wrappers.
const commands = [
	[process.execPath, "apps/api/server.ts"],
	[process.execPath, "apps/worker/main.ts"],
	[
		process.execPath,
		"node_modules/vite/bin/vite.js",
		"--host",
		"127.0.0.1",
		"--strictPort",
	],
];
const children = commands.map((command) =>
	Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }),
);
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((child) => child.exited));
stop();
await Promise.all(children.map((child) => child.exited));
