import { useEffect, useRef } from "react";

export function DeleteResearchDialog({
	topic,
	pending,
	error,
	onCancel,
	onDelete,
}: {
	topic: string;
	pending: boolean;
	error: string | null;
	onCancel: () => void;
	onDelete: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		ref.current?.showModal();
		return () => {
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className="delete-dialog"
			aria-labelledby="delete-title"
			aria-describedby="delete-description"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onCancel();
			}}
		>
			<h2 id="delete-title">この調査を完全に削除しますか？</h2>
			<p className="delete-topic">{topic}</p>
			<p id="delete-description">
				検索結果、取得した本文、根拠、生成したレポート、レビュー結果、実行履歴をストレージから削除します。元に戻すことはできません。実行中の調査も停止します。
			</p>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<div className="delete-actions">
				<button type="button" disabled={pending} onClick={onCancel}>
					キャンセル
				</button>
				<button
					type="button"
					className="danger"
					disabled={pending}
					onClick={onDelete}
				>
					{pending ? "削除しています…" : "完全に削除する"}
				</button>
			</div>
		</dialog>
	);
}
