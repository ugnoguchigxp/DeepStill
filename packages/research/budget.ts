import type { Job, Usage } from "../contracts";
export interface BudgetHold {
	id: string;
	tokens: number;
	requests: number;
	state: "held" | "released";
	reason: string;
}
export function finalHold(job: Job): BudgetHold {
	return {
		id: "final",
		tokens:
			job.mode === "mock"
				? 12000
				: Math.min(150000, Math.floor(job.budget.tokens * 0.55)),
		requests: job.mode === "mock" ? 1 : 4,
		state: "held",
		reason: "回答統合・レビュー・必要時の改稿と再レビュー",
	};
}
export function evaluationHold(job: Job, estimate = 8000): BudgetHold {
	return {
		id: "evaluation",
		tokens:
			(estimate + (job.config.llmProvider === "codex" ? 20000 : 0)) *
			(job.mode === "live" ? 2 : 1),
		requests: job.mode === "live" ? 3 : 2,
		state: "held",
		reason: "ラウンド評価・追加探索の独立レビューと不正応答の修正",
	};
}
export function fits(job: Job, amount: Partial<Usage>, holds: BudgetHold[]) {
	const tokens = holds
		.filter((h) => h.state === "held")
		.reduce((n, h) => n + h.tokens, 0);
	const requests = holds
		.filter((h) => h.state === "held")
		.reduce((n, h) => n + h.requests, 0);
	return (
		job.usage.tokens + (amount.tokens ?? 0) + tokens <= job.budget.tokens &&
		job.usage.requests + (amount.requests ?? 0) + requests <=
			job.budget.requests
	);
}
