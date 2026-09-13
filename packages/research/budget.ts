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
				: Math.min(
						job.config.memoryVersion === 1 ? 280000 : 150000,
						Math.floor(job.budget.tokens * 0.55),
					),
		requests: job.mode === "mock" ? 1 : job.config.memoryVersion === 1 ? 12 : 4,
		state: "held",
		reason: "回答統合・レビュー・必要時の改稿と再レビュー",
	};
}
export function evaluationHold(job: Job, estimate = 8000): BudgetHold {
	return {
		id: "evaluation",
		tokens:
			(estimate + (job.config.llmProvider === "codex" ? 20000 : 0)) *
			(job.mode === "live" ? (job.config.memoryVersion === 1 ? 6 : 2) : 1),
		requests:
			job.mode === "live" ? (job.config.memoryVersion === 1 ? 10 : 3) : 2,
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
		(["queries", "urls", "documents", "costUsd"] as const).every(
			(k) => job.usage[k] + (amount[k] ?? 0) <= job.budget[k],
		) &&
		job.usage.tokens + (amount.tokens ?? 0) + tokens <= job.budget.tokens &&
		job.usage.requests + (amount.requests ?? 0) + requests <=
			job.budget.requests
	);
}

/** Separate admission limits; old runs without directional caps keep their total cap. */
export function tokenBudgetFits(job: Job, amount: Partial<Usage>) {
	return (
		job.usage.tokens + (amount.tokens ?? 0) <= job.budget.tokens &&
		(job.usage.inputTokens ?? 0) + (amount.inputTokens ?? amount.tokens ?? 0) <=
			(job.budget.inputTokens ?? Infinity) &&
		(job.usage.outputTokens ?? 0) +
			(amount.outputTokens ?? amount.tokens ?? 0) <=
			(job.budget.outputTokens ?? Infinity)
	);
}
export function splitTokenReservation(tokens: number, outputTokens: number) {
	const output = Math.min(tokens, outputTokens);
	return { tokens, inputTokens: tokens - output, outputTokens: output };
}
