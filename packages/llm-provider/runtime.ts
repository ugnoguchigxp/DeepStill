import { delimiter } from "node:path";

export function resolveCodexPath(env: NodeJS.ProcessEnv = process.env) {
	const path =
		env.CODEX_PATH ||
		Bun.which("codex", {
			PATH: (env.PATH || "")
				.split(delimiter)
				.filter((entry) => !entry.includes("node_modules/.bin"))
				.join(delimiter),
		});
	if (!path) throw new Error("CODEX_CLI_NOT_FOUND");
	return path;
}
export function inspectCodex() {
	try {
		const path = resolveCodexPath();
		const result = Bun.spawnSync([path, "--version"], { timeout: 5000 });
		const version = new TextDecoder().decode(result.stdout).trim();
		const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
		const compatible =
			!!match && (Number(match[1]) > 0 || Number(match[2]) >= 149);
		if (result.exitCode || !compatible)
			return { ready: false, path, version, error: "CODEX_CLI_TOO_OLD" };
		return { ready: true, path, version, error: null };
	} catch (e) {
		return {
			ready: false,
			path: null,
			version: null,
			error: e instanceof Error ? e.message : "CODEX_CLI_UNAVAILABLE",
		};
	}
}
