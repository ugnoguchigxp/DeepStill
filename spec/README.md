# DeepStill 設計資料

`spec/` はコンセプト、設計判断、実装計画、依存技術の評価を置く場所とする。

| 文書 | 役割 |
| --- | --- |
| [ワールドモデル発見タブ実装計画](world-model-discovery-plan.md) | 関係候補・条件・根拠・未解決点の発見プロセスと表示。V0実装済み。実調査品質は未確認 |
| [実装記録](implementation-status.md) | 実装済み範囲、検証結果、live検証の残件 |
| [実装計画](plan.md) | v0.1の実装範囲、構成、実装順、完了条件の正本。実装時はここから読む |
| [ラウンド探索の実装計画](round-research-plan.md) | 次期探索の正本。逐次キュー、LLMによる回答十分性評価、残予算を使う補足・トリビア探索 |
| [ラウンド探索計画の採点](round-research-review.md) | 固定基準による78→91→95点の改訂記録と残課題 |
| [ラウンド探索v2の実装記録](round-research-implementation.md) | 実装範囲、計画から具体化した点、検証結果、LocalLLM実測の残件 |
| [Memory先行・品質改善計画](memory-first-research-plan.md) | Memory先行設計を継承し、実内容の欠陥を原文再読・修正・探索・再検査まで閉じる次の実装範囲と完了条件 |
| [Memory先行v1の実装記録](memory-first-implementation.md) | 現在の実装、実生成の失敗と未達、評価ハーネスの制約 |
| [途中レビュー改善記録](round-quality-improvement.md) | レポート72→58→64→71→67の失敗記録と改善計画の経緯 |
| [コンセプト](concept.md) | 元のplan.mdにあった目的、原則、将来像を保存。実装計画との差は具体化・段階化として扱う |
| [依存パッケージ評価](dependency-evaluation.md) | hono-standard、llm-fetch、spec-html、s11tnextの確認結果と制約 |

新しい設計判断は実装計画と対応する設計書へ反映する。調査によって生成されたResearch Artifactは `data/artifacts/` に保存し、プロジェクトの設計書と混在させない。実行状態と根拠関係の正本はDeepStillのDBであり、静的Artifactはその派生出力とする。

文書形式はMarkdownを基本とし、spec-htmlでそのまま閲覧する。元資料をHTMLへ一括変換する必要はない。文書内リンクはこのディレクトリからの相対パスを使う。

次のscriptで設計書を閲覧・検査する。

```sh
bun run docs
bun run docs:check
```

アプリの起動・運用手順はリポジトリ直下のREADMEを参照。

- [「LLMと宗教」実調査・改善記録](llm-religion-evaluation.md)

- [Memory中心の逐次探索：改善実装と検証](memory-first-improvement-implementation.md)

- [Memory探索の残課題と充足検証](memory-first-fulfillment.md)

- [探索制御とSystemContextの契約修正・再評価](research-control-contract-review.md)

- [PDF本文抽出・ページ引用・品質評価](pdf-reading.md)
