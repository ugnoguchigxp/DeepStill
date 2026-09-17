import type { RepositoryIdentity } from "../repository-identity";

export interface KnowledgeLookupContext {
	repository?: RepositoryIdentity;
}

export interface KnowledgeResult {
	items?: {
		id: string;
		title: string;
		body: string;
		lastVerifiedAt?: unknown;
	}[];
	state: "disconnected" | "known" | "verify" | "explore" | "unavailable";
	ids: string[];
	reason: string;
}

export interface KnowledgeProvider {
	lookup(
		query: string,
		signal: AbortSignal,
		context?: KnowledgeLookupContext,
	): Promise<KnowledgeResult>;
}

export const emptyKnowledge: KnowledgeProvider = {
	async lookup() {
		return {
			state: "disconnected",
			ids: [],
			reason: "ContextStill未接続。既知情報は未確認。",
		};
	},
};
