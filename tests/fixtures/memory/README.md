# LLMとWeb探索の再利用ケース

保存済み実探索 `data/evaluations/llm-web-editorial-2/detail.json` の引用・イベントから作問した30ケース。各軸10件、奇数development・偶数holdout。期待値は元資料の対象条件とイベントをもとに記載し、生成Memoryの出力から逆算しない。

小規模な初期評価であり一般的な精度の推定ではない。現状は軸内のケースを等重みで集計する。計画書の下位項目別重み付けは未導入。holdoutを修正へ利用した場合はその使用を記録し、別ケースで検証する。

2026-09-13の監査では、旧holdoutの独立した未使用履歴を確認できなかった。改善版では `llm-web-development-v2.json` の全30件をdevelopmentとして扱う。原ファイルは過去の記録として残す。採点版と役割の置換は `evaluation-manifest.json` に保存した。

追補の `llm-web-holdout-v3.json` は、生成・検索実装の凍結後に保存原文と実イベントから作成した新規3ケース。`holdout-v3-manifest.json` にケース・固定Memory・実装のハッシュを保存する。各軸1件の小規模holdoutであり、30件の開発ケースや未使用テーマの評価の代わりにはしない。結果は `spec/memory-first-fulfillment.md` に記録する。これらの期待値を生成やプロンプト調整へ渡した場合は、未使用holdoutとして再利用しない。
