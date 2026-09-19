# DeepStill v0.1 実装記録

2026-09-20追記: [ワールドモデル発見タブ](world-model-discovery-plan.md) のV0（WM-01〜07）を実装した。新規 deliverables-v1 Job は本文読解時に関係候補を生成し、調査詳細タブと `evidence.json` から参照できる。専用LLM呼出し、World Model登録、既存調査の再生成は含まない。実装・回帰は確認済み。同一テーマでの実モデル品質比較は未実施であり、fixture成功を実調査品質の合格と読み替えない。

2026-09-12追記: [Memory先行生成v1](memory-first-implementation.md)を実装。Knowledge・Episode・概念をレポートより先に生成する。再利用品質90点超は未達で、実装範囲と残る検証は同文書に記載した。

2026-09-12追記: 新規調査の逐次キューとラウンド評価を実装した。[ラウンド探索v2の実装記録](round-research-implementation.md)を参照。以下のv0.1記録は当時の実装を保持する。

更新日: 2026-09-12。ローカル単体PoCの実装と検証を実施。実サービスのcredentialを必要とするlive検証と、実調査100件の品質評価は未実施。

## 実装した範囲

| 段階 | 実装と確認 |
| --- | --- |
| M0 基盤 | authless雛形を一時領域へ生成してbaselineを検証。Bun/Hono/React/Vite/Query/Zod/Drizzle、独立API/Worker、spec-html、検証scriptとCIを整備 |
| M1 永続化 | SQLite WAL・busy_timeout、原子的lease取得、heartbeat、古いownerの書込み拒否、予算予約・実usage精算、復旧用operation記録 |
| M2 探索 | Query Graph、正規化、depth/score、best-first、domain多様性、round、飽和・予算・候補枯渇停止。DataForSEO Autocomplete LiveとOrganic Queue Adapter |
| M3 根拠 | llm-fetch/Playwright fallback、本文snapshot/hash、段落選択、UTF-16引用位置、guard拒否・truncationの保存 |
| M4 LLM | s11tnext catalog/manifest、chat-completions互換Adapter、Claim抽出と支持/矛盾候補・重複分類、検証済みClaimの選択とArtifact生成 |
| M5 UI | テーマ・予算入力、Dashboard、探索経路、Findings、引用詳細、停止、永続SSE、レポート・根拠JSONの静的出力 |
| M6 連携と評価基盤 | ContextStill MCP SDKのread-only lookup、候補JSON出力、手動採否API、品質指標API、100件fixture評価script |

元テンプレートの単一プロセス向けDB runtimeは移植せず、DeepStill用に再実装した。API・UIも研究用に構成し直した。テンプレートの検証方式・Biome設定・技術構成を再利用し、licenseを残している。

## 確認できたこと

- 雛形baseline: typecheck、lint、format、coverage、build、デスクトップ/モバイルのE2E 4件に成功。
- DeepStill: `bun run verify` に成功。型・lint・format・Bun test 24件・build・spec-html lintを含む。
- DeepStill E2E: デスクトップ/モバイル合計6件に成功。調査完了、引用表示、Escapeでの閉鎖、停止、リロードを確認。
- 実プロセス2つで同一taskを競合取得し、1つだけが取得できることを確認。ownerをSIGKILLした後、期限切れで再取得し、旧tokenによる書込みを拒否。
- 予算超過のtransaction rollback、結果不明APIの再送拒否、保存済み結果の再利用、期限停止、キャンセルを検証。
- 存在しない引用・変更されたsnapshotを拒否し、日本語と絵文字を含む引用位置を確認。
- 公開llm-fetchとReadabilityを同じHTML fixtureで比較し、根拠となる段落が両方で保持されることを確認。guard拒否、truncation、private destination拒否も確認。
- DataForSEOの同期suggest/非同期submit/poll、待機と空結果の区別、読み取りGETの限定再試行、LLM usage不明、ContextStill MCP初期化・lookupをstubで検証。
- frozen lockfile install、migration、オンラインbackupとintegrity_checkに成功。

テスト件数・最新実行結果は実行ログを参照する。fixture評価は100 Job、100完了、400採用Claim。全Artifactの引用を検証した。fixtureが想定どおり動いた結果であり、未知情報発見率や実際のKnowledge採用率を示さない。

## 設計を具体化した点

### 保存形式

Job/task/eventは独立テーブルに保存する。Query、Source、Evidence、Claimなどのpayloadは、job_id/kind/idを主キーとするDrizzle管理のrecordsテーブルへ保存する。PoCでは各Entityごとのtable増殖を抑え、根拠関係はアプリの検証関数で確認する。大規模集計を必要とする段階でEntity別のschemaへ移行する。

migrationは `packages/db/migrations/0001.sql` を正本とし、checksumを検証する。SQLとschemaを変更する場合は新しいmigrationを追加し、適用済みSQLを書き換えない。

### Artifactの本文

LLMは保存済みClaimの選択と順序付けを行い、本文はClaimから決定的に構成する。新しい文章を自由生成して引用を後付けする方式は採らない。矛盾候補は自動採用せずFindingsへ残す。claim textとquoteの意味的な妥当性には人間の確認も必要。

### 予算と費用

検索の課金POSTは保守的な金額を予約し、応答で精算する。LLM tokenは対応byte tokenizerを前提としたUTF-8 bytes＋最大出力＋overheadの上限見積もり。usage不明時は予約額を保持する。金額上限は検索費用を対象とし、LLM料金は未計算。

タイムアウト・crashで応答が不明な課金requestは停止し、自動再送しない。DataForSEO task IDを保存できている場合はpollを継続できる。429/5xxのpollは上限付き再試行。Crawlerのretryable errorは最大2回再試行。LLM・課金POSTの自動再送は行わない。

### ContextStill

ローカルContextStillコードで確認した `search_knowledge` の入力/出力に合わせた。MCP SDKがinitializeとStreamable HTTPを扱う。関連Knowledgeがあればverify、空ならexplore、未接続・失敗は別状態。同名一致だけで鮮度・根拠が十分とは断定せず、live経路では自動known skipを行わない。Knowledge Provider契約自体はknownを扱える。

Candidateの採否記録はDeepStillのローカル評価記録であり、ContextStillに登録済みという意味ではない。

## 残るlive検証

次はcredentialと接続先を設定した環境で行う。

1. DataForSEOで小さな予算のJobを実行し、実task ID、poll結果、請求額が台帳と一致するか確認する。
2. LARM等の実LLMでJSON応答、usage、モデルのtoken上限を確認する。
3. ContextStill実endpointの認証・lookup結果を確認する。
4. 動的ページ・文字コード・長文を含む実資料群で取得成功率と本文欠落を評価する。現在のReadability比較は小さいfixtureに限る。
5. 100件以上の実Research Jobと人間の採否レビューを蓄積し、NEW率・Duplicate率・Knowledge採用率・費用効率を評価する。

この工程をfixture結果で代替したことにはしない。PDF/OCR、定期再調査、分散実行、Tauriは計画どおり対象外。

## 参照

- [実装計画](plan.md)
- [依存評価](dependency-evaluation.md)
- [DataForSEO Autocomplete Live](https://docs.dataforseo.com/v3/serp/google/autocomplete/live/advanced/)
- [DataForSEO Organic task_post](https://docs.dataforseo.com/v3/serp/google/organic/task_post/)
- [DataForSEO Organic task_get](https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/)

## Codex実調査による拡張（2026-09-12）

Codex SDK 0.135.0を追加し、luna / lowで検索・抽出・統合を実行する経路を実装した。既存ContextStillのCodex設定とproviderを参考にした。構造化出力の必須プロパティ、長い段落の切り出し、日本語の主張、参照付きの章立て、品質レビューと版を保持する改稿を追加した。旧来の「主張を並べるだけ」という制約はこの経路では解消した。

Codex token予約は内部コンテキストと検索の実行回数を含む厳密な上限ではない。usage精算と後続呼び出しの停止により管理する。DataForSEOとContextStillの実接続検証は引き続き別途必要であり、今回のCodex接続成功と混同しない。

実資料では、LLMが改行を空白に置き換えて引用を出すことがあった。一意な空白正規化一致のみを原文へ写像し、保存する引用とUTF-16位置は原文そのものとした。意味的な近似一致は採用しない。生成時の引用IDは採用済みIDのenumで制限し、参照一覧は段落から導出する。

SDKはユーザーのMCP設定を継承し得る。実測で1回、抽出中にContextStillのread-only toolが呼ばれたため、設定された各MCP serverを明示的に無効化し、外部tool・shell・file変更を含む応答を拒否するよう変更した。モデル・reasoning・usage・tool itemはauditに保存する。

llm-fetchが未対応だったISO-8859-1 / Windows-1252のHTMLは、安全なHTTP取得後に宣言された文字コードをUTF-8へ変換してから、同じguardと抽出器へ渡す。元レスポンスのhashと文字コードを残す。guardの判定は緩和していない。

## Memory中心の逐次探索の改善

2026-09-13に新規ジョブ用の `researchControlVersion: 2` を追加した。問い・行動候補・採否・段階読解・依存差分・原文検索・最終レビューからの復帰は [改善実装と検証](memory-first-improvement-implementation.md) を参照。品質90点超、未使用holdout、LocalLLM、外部登録互換の合格を意味しない。

同日の追補として、追加読解・未取得候補の取得・評価予算予約・Episodeの検索を修正し、独立した実探索充足監査を追加した。[残課題の実装と充足検証](memory-first-fulfillment.md)に全試行を記録する。LocalLLM実測はユーザー指定により今回の対象外。実探索は取得保留と根拠不足により未充足であり、回帰試験成功を品質合格へ読み替えない。

## PDFの読み取り改善（2026-09-13）

埋め込み文字のPDF対応を拡張し、ページ別の本文位置・未読状態・抽出上限、水平な二段組みの読み順、ページ付き引用を追加した。OCR・画像の意味解析は引き続き対象外。以前のPDF対象外という記述からの更新と制約は[PDF実装記録](pdf-reading.md)を参照。
