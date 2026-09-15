# S2 終了前の具体例要求 — 不採用

基準7372ef8（採用済みソースはe363eb5と同じ）、候補604531176e3892ff5d18fbad3aa6e0198a1b1125、remote保存codex/experiment-incremental-s2-20260915。差し戻し318d64e34bd7。保存先は残す。

変更はdeliverable_stepの2文追加のみ。列挙では機構の説明にならないこと、概説終了前に根拠付き入出力例と条件・トレードオフを得ることを要求した。全verify成功、モデル・予算・引用検証・ガード・保存方式は不変。

可逆圧縮52→64、画像58→67。ただし可逆圧縮で比較相手BrotliをDEFLATEと誤記、画像でunsafe-shownを安全な表示と誤訳。両候補ともpartial、途中説明の脱落、約7–11倍の入力増・約13–14倍の出力増があった。予測した具体例探索は起きたが、採用のガードレールを満たさない。画像は候補先行の補足対、規定の採用検証16試行は未実施。

詳細な配点・event・実行ID・費用とsource hash照合は[実験記録](../experiments/INCREMENTAL-20260915.md)。実ログはdata/evaluations/incremental-20260915/{compression-baseline,compression-s2,image-baseline,image-s2}/。今回の候補を再現する場合は保存ブランチを別環境で参照し、mainへ無条件に積み重ねない。
