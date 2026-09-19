import type { Artifact } from "../contracts";

export function selectDiscoveryArtifact(artifacts: Artifact[]): {
	artifact: Artifact | undefined;
	stale: boolean;
} {
	if (!artifacts.length) return { artifact: undefined, stale: false };
	const latest = artifacts.reduce((current, item) =>
		item.version > current.version ? item : current,
	);
	const discovered = artifacts.filter((item) =>
		Array.isArray(item.worldModelDiscovery?.candidates),
	);
	if (!discovered.length) return { artifact: undefined, stale: false };
	const artifact = discovered.reduce((current, item) =>
		item.version > current.version ? item : current,
	);
	return { artifact, stale: artifact.version !== latest.version };
}
