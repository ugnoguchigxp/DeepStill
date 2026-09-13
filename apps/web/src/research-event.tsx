import type { Event } from "../../../packages/contracts";
export function ResearchEvent({ event }: { event: Event }) {
	const d =
		event.data && typeof event.data === "object"
			? (event.data as Record<string, unknown>)
			: {};
	if (event.type === "research.decision" && d.actor === "llm")
		return (
			<div>
				<strong>LLMによる次の行動: {String(d.action)}</strong>
				<p>{String(d.purpose ?? "")}</p>
				<p>{String(d.target ?? "")}</p>
				<small>
					判断の契機:{" "}
					{d.trigger === "retrieval_failed"
						? "取得失敗"
						: d.trigger === "source_read"
							? "本文の読解"
							: "検索結果"}
					{d.parentSourceId
						? ` · リンク元資料: ${String(d.parentSourceId)}`
						: ""}
				</small>
			</div>
		);
	if (event.type === "research.action")
		return (
			<div>
				<strong>{String(d.action ?? "")}</strong>
				<p>{String(d.purpose ?? "")}</p>
				<p>{String(d.result ?? "")}</p>
			</div>
		);
	return (
		<div>
			<strong>{event.type}</strong>
			<pre>{JSON.stringify(event.data)}</pre>
		</div>
	);
}
