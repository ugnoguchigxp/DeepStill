# Memory中心の逐次探索：改善実装と検証

更新日：2026-09-13。対象は `memory-first-research-plan.md` の改訂計画。v1の記録は `memory-first-implementation.md` に保持する。

## 実装した変更

新規ジョブは `researchControlVersion: 2` を保存する。旧ジョブは設定を変更せず、従来の評価・キューで実行できる。`MEMORY_FIRST_ENABLED=0` は新規ジョブの旧経路への切替であり、既存Memoryの参照を削除しない。

| 対象 | 変更と保存する情報 |
| --- | --- |
| 問い | 明示／推定、用途、必須性、充足条件、根拠、未確認、親の問い、変更理由、版を保存。明示要件の削除・任意化は拒否する |
| 方針 | 元依頼、原文索引、既読範囲、採否・取得状態、未解決、残予算から候補を最大3件比較。旧round評価とopportunityレビューを二つの新しい役割へ置換する |
| 行動 | 一件を採用し、複数の問い・欠陥へ対応させる。依存、対象、重複、予算を検査。モデルの候補IDはコードが採番する |
| 資料 | 取得承認待ちと通信失敗を区別する。独立候補は検討できるが、承認待ち資料を迂回取得しない。本文の節索引から範囲を選び、抽出後に支持検証する |
| Memory | 根拠ゼロならKnowledge・Concept生成を省略。根拠とイベントの依存hashを分け、無変更の生成を再利用。変更根拠に関係するKnowledge・Conceptを更新し、無関係な項目を保持する |
| 容量 | 大きい入力は依存対象ごとに分割し、未選択IDを明示する。最小単位が入力上限を超える場合は明示的に停止し、途中のMemoryを保存する |
| 欠陥 | 同じ対象・解消条件を追跡する。レビューから消えただけでは解消せず、明示的な再検査と理由を保存する。修復回数を制限する |
| 版 | Memoryと本文の旧版を保持する。最終レビューの事実不足は探索へ戻し、研究revisionを更新して新しい成果物を保存する |
| 終了 | 調査充足、Memory検査、再利用試験、レポート検査、停止理由をOutcomeとして分ける。未実施の再利用試験を合格にしない |

LLM・検索・取得は既存の単一実行枠と操作台帳を使用する。結果がunknownの外部呼び出しは自動再送しない。新経路でもジョブ作成時の予算を維持する。

原文の範囲はUTF-16位置で固定し、日本語・絵文字・改行を含む実UTF-8位置への変換、範囲の重複、スナップショットのhashを検査する。索引のプレビューは根拠に採用しない。推定した関係にはsuggestedを付ける。

## 後続利用

Knowledgeにできない定義・測定結果もEvidenceとして検索・詳細取得できる。候補にはMemory版、研究revision、時点、状態を付ける。生成会話を渡さない利用側が、質問から検索語を選び、対象の構造、引用、実行イベントへ逐次たどるハーネスを追加した。利用側が実際に読んだ原文を採点側へ渡す。

| API | 用途 |
| --- | --- |
| `/api/memory/search?q=...&state=accepted` | ジョブをまたぐ現在のMemory検索。draft・disputedは状態を明示して選択する |
| `/api/jobs/:id/memory?version=...&q=...` | 保存版を指定した検索。Evidenceも対象 |
| `/api/jobs/:id/memory?version=...&object=...` | 構造、対象の版情報、関連関係を取得 |
| `/api/jobs/:id/memory?version=...&evidence=...` | 固定引用と周辺原文へ戻る |
| `/api/jobs/:id/memory?version=...&snapshot=...` | 原文の範囲索引を取得 |
| `/api/jobs/:id/memory?version=...&snapshot=...&hash=...&start=...&end=...` | 指定した保存原文範囲を取得 |
| `/api/jobs/:id/memory?export=contextstill` | 登録せず候補変換を確認。UTF-8位置は実計算し、接続先の互換確認とは区別する |

contextStill自動登録、Episode登録、SAAA専用adapterは対象外のまま。概念の大規模な同一性解決も行わない。

## 検証方法

`tests/memory-direction.test.ts` はT1〜T5の制御、依存差分、容量、原文参照、後続検索、明示的な欠陥再検査を検査する。既存のv1キュー回帰は旧設定で維持し、旧ジョブの互換性も確認する。

fixtureの成功は制御と参照契約の検証である。再利用の三軸90点超を示すものではない。

比較点は `data/evaluations/memory-improvement-baseline` に、開始時の差分・ファイルhash・ソース・検証ログとして保存した。実験はmanifestを先に保存し、途中結果と失敗も残す。

```sh
# 固定原文からMemoryを生成。Web検索はしない。
bun scripts/memory-fixed.ts detail.json NEW_OUTPUT_DIR

# 元条件を継承する実探索。予算を増やさない。
bun scripts/memory-experiment.ts baseline-detail.json NEW_OUTPUT_DIR live

# 確定済み実験DBから再開。未確定の外部操作がある場合は拒否する。
bun scripts/memory-experiment.ts previous-experiment/detail.json NEW_OUTPUT_DIR resume

# 質問→検索→詳細→原文→回答→独立採点。全試行を保存する。
bun scripts/memory-reuse.ts detail.json memory.json cases.json NEW_OUTPUT_DIR development 1
```

入力上限はジョブ作成時に `MEMORY_CONTEXT_BYTES`、`SOURCE_RANGE_BYTES`、`SOURCE_RANGE_LIMIT`、`LLM_INPUT_BYTES` から保存する。これらは能力設定であり、特定のLocalLLMを実測した証明ではない。

## 評価の現在地

既存30ケースのholdout利用履歴を独立に確認できなかったため、v2の評価用コピーは全件developmentへ移した。原ファイルの旧ラベルは履歴として保持する。判定は `tests/fixtures/memory/evaluation-manifest.json` に記録し、未使用holdoutの3回合格とは扱わない。

最初の同テーマliveでは4資料すべてが取得承認待ちだった。Memoryの空生成は省略できたが、行動選択が未実行候補への不正な依存を含み、停止した。これは成功扱いにしない。依存先を完了済みwork IDへ制限し、取得失敗を保存原文として参照できないよう修正した。

再開実験では、独立した次の検索へ進んで2資料を読解した。承認待ち資料の迂回ではない。取得成功率の違いと、制御の修正による違いを分け、Web変動のない比較だったとは主張しない。最終的な使用量・Memory・本文・停止理由は各実験の結果ファイルを正本とする。

実験ランナーではSQLite本体だけを複製してWAL内の確定結果を落とす問題も検出した。その試行を残して停止し、SQLiteの整合したserializeによる複製へ変更した。未確定外部操作を再送して回復したことにはしない。

ローカルの既定モデルエンドポイントには接続できなかった。LocalLLMの速度・構造出力・実効入力容量は未検証。外部互換、未使用テーマ、独立holdoutの品質合格も、機能検証と分けて報告する。

## 実モデルで保存した結果

実験は `data/evaluations/` 以下に保存した。入力・呼び出し・途中出力・失敗記録を保持し、後の成功で前の失敗を置換していない。

| 試行 | 観測 | 判定 |
| --- | --- | --- |
| `memory-improvement-live-1` | 4資料が承認待ち。根拠0件のKnowledge・Concept呼び出しを省略。不正な行動依存で停止 | 未達。依存先のschema制限を追加 |
| `memory-improvement-live-resume-1` | 実験DBのWALを落とすランナー不具合で旧状態を読んだ | ランナー失敗。外部操作を再送せず停止 |
| `memory-improvement-live-resume-2` | 整合したDBから再開し、累計2検索・8URL・2読解・13支持済み主張。912,643トークン・44要求 | `generation_budget_exhausted`。Memoryと未達本文を保存 |
| `memory-improvement-fixed-v1` | 固定原文から開始時のv1実装で生成。4要求・114,660トークン | 比較用Memory。レビュー推定値を再利用品質としない |
| `memory-improvement-fixed-v2` | Knowledgeの確認方法欠落 | 失敗。v2生成の確認方法をschemaで必須化 |
| `memory-improvement-fixed-v2-repaired` | 生成3段階は保存できたが、レビューが存在しない欠陥IDを再検査済みとした | レビュー不採用。未知IDの検査と出力制約を追加 |
| `memory-improvement-fixed-v2-review-corrected` | 生成済み3段階を保持し、レビューのみ再実行。構造不備なし | 生成3段階72,273＋レビュー56,248＝128,521トークン。内容上の欠陥は残る |
| `memory-improvement-reuse-v2` | 複数語の完全一致検索で必要情報へ届かなかった | 開発ケース3件すべて0点。検索を修正 |
| `memory-improvement-reuse-v2-corrected` | 検索から根拠へ戻れたが、回答がclaim IDをobject IDとして引用した | 不正参照を含むため不合格。回答のIDを取得済み集合に限定 |
| `memory-improvement-reuse-v2-grounded` | 質問から検索・原文回復を実行。Knowledge 100、Episode 0、原文回復100。279,842トークン | Episodeの重大欠陥が残るため不合格 |

v2固定生成の128,521トークンは、採用した3生成と再レビューだけの費用である。失敗したKnowledge生成23,582トークンと、不採用レビュー57,411トークンは別に発生しており、改善に要した全費用から除外しない。レビュー推定値はv1が62/78/67、再レビュー後v2が54/61/43だった。この値の上下で改善を主張しない。

再利用の3ケースは既存developmentの各軸1件で、全30件の成績やholdoutの代替ではない。Episodeでは、初回検索語を復元できず、利用側が複数のevent IDを単一ID欄へまとめて指定した失敗も記録された。点数が低いケースを除外せず、今回の品質ゲートは不合格とする。未使用holdout・未使用テーマ3回の合格、LocalLLM実測、外部adapter互換は未確認のまま。

## 検証と既存作業への配慮

開始時の `bun run verify` は113テストを含め成功した。実装後の制御・Memory回帰、型検査、ビルド、docs検査、およびE2Eを実施した。E2Eは17件成功・1件スキップだった。

作業中に同じ作業ツリーでVitest・coverageへの移行が進んだ。既存変更を戻さず、追加したMemoryテストもVitestへ合わせた。移行中の重複プロパティなどの型エラーは意味を保って修正し、coverage実行先の競合時は本実装の検証用ディレクトリを指定した。開始時の差分と今回の実験記録は保持し、別タスクへのメッセージ送信は行っていない。

同じ3ケース・同じ利用ハーネスによる旧版比較 `memory-improvement-reuse-v1-grounded` は、旧版も100/0/100、Episodeの重大欠陥ありだった。旧版の利用費用は287,327トークン・20要求、改善版は279,842トークン・20要求。固定生成の採用工程は旧版114,660、改善版128,521トークンだった。少数の一回比較では再利用品質の向上を確認できず、費用差の一般化もしない。集計は `data/evaluations/memory-improvement-fixed-comparison.json` に保存した。

再利用ランナーにはコード・差分・入力原文・イベント・promptのhashを実行前manifestへ保存する処理を追加した。改善版の最終3ケース試行はこのmanifest拡張前に開始しており、その試行の実際のprompt/schemaは各呼び出しauditを正本とする。保存していないコードhashを事後に実行前の記録として補わない。

最終検証は165テスト／26ファイル成功。coverageはstatements 87.10%、branches 80.01%、functions 89.51%、lines 88.72%で、全項目80%の基準を満たした。型検査、lint、format、build、docs検査も成功した。`bun run verify` の標準coverage出力先は別の実行と競合したため、同じ検査列で `--coverage.reportsDirectory=data/evaluations/memory-improvement-final-validation` だけを指定した。基準の緩和や対象除外は行っていない。最終ログとソースmanifestは `data/evaluations/memory-improvement-final-audit` に保存した。

内部機能の実装完了と、再利用品質合格は分ける。T1〜T5・容量・版・原文参照の回帰は成功、T6/T7の実モデル評価は実施して不合格を保存した。未使用holdoutや指定LocalLLMが未検証であるため、計画全体の品質リリース条件を満たしたとはしない。
