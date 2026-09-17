import type { ResourceIdentity } from "./resource";

export * from "./resource";

export interface SourceCapabilities {
	connectorKind: string;
	connectorInstanceId: string;
	search: boolean;
	fetch: boolean;
	locatorKinds: string[];
}

export interface SourceSearchRequest {
	query: string;
	limit: number;
	scope?: Record<string, string>;
}

export interface SourceHit {
	resource: ResourceIdentity;
	title: string;
	snippet: string;
	rank: number;
}

export interface SourceFetchRequest {
	resource: ResourceIdentity;
	fragment?: { kind: string; value: Record<string, string | number> };
}

export interface ResourceSnapshot {
	resource: ResourceIdentity;
	title: string;
	text: string;
	hash: string;
	fetchedAt: string;
	truncated: boolean;
	metadata?: Record<string, unknown>;
}

export interface SourceConnector {
	capabilities(): SourceCapabilities;
	search(input: SourceSearchRequest, signal: AbortSignal): Promise<SourceHit[]>;
	fetch(
		input: SourceFetchRequest,
		signal: AbortSignal,
	): Promise<ResourceSnapshot>;
}
