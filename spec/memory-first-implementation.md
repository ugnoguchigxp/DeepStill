# Memory先行生成 v1 実装記録

更新日：2026-09-12。対象計画は `memory-first-research-plan.md`。これは最初の動作する実装であり、計画全体の品質目標90点超を達成した記録ではない。

## 実装した流れ

新規の逐次探索ジョブは `memoryVersion: 1` を保存する。選択した全資料の処理が確定した後、Knowledge、Episode、Concept、Memoryレビューをそれぞれ一回のLLM呼び出しとして逐次実行する。各段階の入力hash、生成途中のBundle、進行位置をwork itemへ保存し、再開する。

Memoryレビュー後にラウンド評価と次の探索候補の独立レビューを行う。既存の根拠で修正できる `revise_memory` と、周辺原文を確認する `inspect_evidence` は、検索を増やさず一回修正して再評価する。まだ再利用上の不足があるときは、それを埋める `research` の指摘と対応する探索候補だけを許可する。取得の `approval_pending` は通常の検索再試行へ流さない。

最終レポートもMemoryを先に確定して、その版を参照して生成する。本文に採用しなかったKnowledge・Episode・概念と引用位置は保持する。旧ジョブはMemoryがなければ従来の候補生成を使う。

## 変更した契約

- `packages/memory/schema.ts`：ルール、手続き、Episode、概念、型付き関係、レビュー指摘とBundleの契約。
- `packages/memory/index.ts`：原文・全判断イベントの入力、参照検査、レポートと独立した候補化、検索・詳細取得、contextStill向けdry-run export。
- `packages/memory/prompts.ts`：生成・レビューの役割別指示。EpisodeにはKnowledgeの説明文を渡さず、実行イベント中心のコンテキストを渡す。
- `packages/llm-provider/codex.ts`：主張ID、イベントID、指摘対象ID、要件IDを入力に実在する候補へ制限する構造出力。
- `apps/worker/round-engine.ts`：一ステップ一呼び出しの生成、修正、revision検査、Memory版を固定したレポート出力。
- `packages/artifact`：レポートの出力フォルダーへ `memory.json` も保存する。改稿してもMemory候補を重複作成・非表示にしない。
- `packages/db`：既存の汎用レコード保存を使用する。破壊的なDB移行はない。
- `packages/integrations/contextstill`：検索した既知Knowledgeの本文を読み取り結果に保持する。自動登録は行わない。

生成入力のhashには根拠・イベント・研究revisionに加え、Memoryプロンプトとschemaのhashを含める。指示を変更しても以前の生成結果を無条件に再利用するキャッシュにはしない。

## 参照と表示

UIに「Knowledge・Episode」を追加した。件数、ルールの条件、Episodeの行動・結果、未解決の指摘を確認できる。表示する点数はLLMレビューの推定点であり、別実行による再利用試験の点数ではない。

`GET /api/jobs/:id/memory` は最新のBundleを返す。次のクエリに対応する。

| クエリ | 内容 |
| --- | --- |
| `version=<memoryId>` | 特定版を選ぶ |
| `q=<語句>` | Knowledge・Episode・概念の検索 |
| `object=<ID>` | 選んだ項目の構造を取得 |
| `evidence=<evidenceId>` | snapshot hashとUTF-16引用位置を確認して原文範囲を取得 |
| `event=<eventId>` | Bundleが保持する実行イベントを取得 |
| `export=contextstill` | 登録せず候補の変換結果を確認 |

検索は現時点では正規化した部分一致で、ベクトル検索やSAAA専用オントロジーとの接続は未実装。概念間の関係は保存・参照できるが、自動的な多段グラフ探索は行わない。

## 評価ハーネス

`packages/memory/harness.ts` は、生成会話を持たない新しい呼び出しに、検索で見つかったMemory・引用・イベントだけを渡す。回答を別の呼び出しで期待値と原文に照合する。正解は利用側へ渡さず、参照捏造と採点項目の欠落はコードでも検出する。

`tests/fixtures/memory/llm-web-cases.json` に保存済み「LLMとWeb探索」の30ケースを用意した。各軸10件、developmentとholdoutに各5件を分けた。期待値は元の引用・イベントから作問した。現実装は軸内のケースを等重みで集計する。計画の細分化した配点重みは未導入であり、同じ採点方式を実装したとは扱わない。

```sh
# 保存済み根拠から生成する。新しいWeb検索や外部登録はしない。
bun scripts/memory-evaluate.ts detail.json NEW_OUTPUT_DIR

# 作成済みMemoryを再利用テストする。1〜3回を逐次実行できる。
bun scripts/memory-reuse.ts detail.json memory.json cases.json NEW_OUTPUT_DIR development 1
```

CLIはCodexを使用するlive検証用。ワーカー本体は既存のchat-completions互換プロバイダーにも接続できる。実際のLocalLLMでの構造出力・速度・コンテキスト上限は未検証。

Memoryレビューの推定点は三軸すべて90点超・重大欠陥なしを要求する。ただしこれをholdout合格とは呼ばない。再利用試験でも三軸が揃わなければ合格にしない。少数ケースの成功は、テーマ全体や将来の利用で90%成功することの証明ではない。

## 実生成で検出して修正した問題

1. LLMがUUIDの一部分を書き違えた。参照検査で不採用とし、出力スキーマも実在IDへ制限した。
2. 歴史的なベンチマーク測定を、手続きの成功確認として並べた。個別実行の完了確認との区別を生成指示へ追加した。
3. Episodeが調べた手法の紹介に偏った。入力からKnowledge本文を分離し、今回の探索・判断・失敗を記録する指示へ変更した。
4. レビューが対象IDと要件IDを作り替えた。両方を実在IDの列挙で制限した。
5. 根拠IDがないEpisodeの出力制限に使ったJSON Schemaをプロバイダーが拒否した。型付き配列と `maxItems: 0` に変更した。

各失敗と生成途中の内容は `data/evaluations/memory-first-live-v1`〜`v4` に保存した。v4はv3で成功したKnowledge生成を引き継ぎ、Episode以降を再実行した実験である。同条件での独立した4回成功ではない。

v4は構造検査を通過したが、自動レビューの推定点はKnowledge 68、Episode 78、詳細への到達64だった。90点超は未達。以前のレポート評点67とは対象・尺度が違うため、向上率として比較しない。

再利用ハーネスはdevelopmentから各軸1件、計3件を実行した。最初の試験で、意味の同じ表現を内部ラベルの不足で減点することと、正解側の参照リストにない正当な引用を誤参照と判定することを検出した。意味による一致、重大欠陥の具体的理由、利用側が実際に読んだ追加原文の採点側への引き渡しを実装した。

回答を変えず再採点した3件は各100点・重大欠陥なしだった。これはハーネス修正後の動作確認であり、独立した3回のholdout合格ではない。回答・採点・実際のプロンプト・使用量は `data/evaluations/memory-first-reuse-smoke`、`memory-first-reuse-calibrated`、`memory-first-reuse-rejudged` に保持している。失敗した採点を削除していない。

最終検証は `bun run verify` 成功、113テスト成功。E2Eは17成功・1スキップで、新しいMemoryタブの表示とJSONリンクも確認した。型・構造・キューの検証が通っても、Memory品質90点超の証明にはならない。

## 制約と次の検証

- Memoryの入力は現状160,000バイト上限。超過は黙って省略せず明示的に失敗する。LocalLLM向けの小さい範囲への分割・段階取得は今後の実装。
- 原文再確認は関連引用の前後450文字を供給する一段階であり、任意範囲を動的に読むreader loopではない。
- 根拠の存在・引用位置はコードで検証するが、記述全体の支持や過剰一般化はLLMレビューにも依存する。構造検査だけでは合格しない。
- ローカルIDはBundle内で検証する。別ジョブをまたいだ概念同一性の解決と意味による重複排除は未実装。
- 既知Knowledge本文は取得結果に保持するが、既存知識の全原文取得・鮮度判定を含む連携は未実装。
- contextStillのEpisode登録契約とSAAAのAPIは未確認のままである。dry-run結果をそのまま登録済み・互換確認済みと扱わない。
- 30ケース全件のholdoutを3回通す検証、従来方式との固定条件比較、新しいWeb探索を伴う同テーマ比較は残る。90点超を達成した完成版とは扱わない。

## 起動と後戻り

API・ワーカーを再起動すると新規ジョブから有効になる。`MEMORY_FIRST_ENABLED=0` で再起動すると、新規ジョブだけ従来のレポート先行方式へ戻せる。既存ジョブの版・成果物は変更しない。

型・lint・format・テスト・ビルド・文書検査は `bun run verify`、画面の検証は `bun run verify:e2e`。テストは再開、途中のユーザー追加、引用破損、手続きの不足、レポート改稿と候補保持、正解の隔離を含む。
