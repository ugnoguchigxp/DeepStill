# DeepStill

テーマを段階的に探索し、重要な記述から取得時の本文と外部の原典へ遡れるResearch Artifactを保存する、ローカル向けResearch Engineです。

## 起動

Bun 1.3.14以上を使用します。

```sh
bun run bootstrap
bun run dev
```

Web UIは http://127.0.0.1:5173 、APIは http://127.0.0.1:4310 で起動します。API・Worker・Webは別プロセスです。停止はCtrl+C。個別起動は `bun run api`、`bun run worker`、`bun run web` を使います。migrationは起動前に `bun run db:migrate` で適用してください。

「固定サンプルで動作確認」はcredentialなしで動きます。固定の検索結果・本文・LLM応答を使い、テーマの実際の調査は行いません。レポートと出力JSONにもfixtureであることを残します。

## ラウンド探索

新規調査は「一次検索 → LLMによる資料選出 → 選出資料の逐次読解・検証 → 回答の十分性と追加価値の評価」で進みます。十分な回答ができても、残予算と価値のある候補があれば補足やトリビアを調査します。既定は最大6ラウンドです。

画面から待機タスクの優先変更と次ラウンドの候補追加ができます。資料・キュー・評価はDBへ保存し、停止後も同じ位置から再開します。外部処理の終了が不明な場合は実行枠を保持するため、外部サービス側の終了を確認して画面へ記録してください。

保存済みの旧Jobは従来方式で再開します。新方式の新規作成を止めるには `ROUND_ENGINE_ENABLED=0` を設定して再起動します。実装と制約は[ラウンド探索v2](spec/round-research-implementation.md)を参照してください。

## Web調査

新規の逐次探索では、Knowledge・Episode・概念索引を途中生成してレビューした後、人間向けレポートを作ります。「Knowledge・Episode」画面とMemory APIで参照できます。LLMの推定点と再利用試験の成績は別です。実装・評価コマンド・制約は[Memory先行生成v1](spec/memory-first-implementation.md)を参照してください。

`.env.example` を参考に `.env` へDataForSEOのlogin/password、LLM_BASE_URL、LLM_MODEL、必要ならLLM_API_KEYを設定します。設定後にAPIとWorkerを再起動し、UIで「Web調査」を選びます。秘密情報はブラウザーへ返しません。

Codex SDKを使う場合は `codex login` を済ませ、`.env` に `LLM_PROVIDER=codex` と `SEARCH_PROVIDER=codex` を設定します。モデルは `gpt-5.6-luna`、reasoningは `low`。検索にはCodex Web、本文取得にはllm-fetchを使用します。空の一時ディレクトリ、read-only、承認なし、shell無効の独立した呼び出しで処理します。UIにはプロバイダー・モデル・reasoningを表示します。

- DataForSEO: v2ではOrganic task_post/task_getを逐次実行します。従来Jobの再開ではAutocomplete Liveも利用します。課金request前に意図を保存し、結果不明時は再送しません。
- LLM: `/v1/chat/completions` 互換のJSON応答を使用します。LARMの接続先をこの形式で設定できます。実際のLARM環境との互換性は接続時の検証が必要です。
- Crawler: llm-fetchによるHTTP取得と必要時のPlaywright。動的ページを取得するには `bunx playwright install chromium` でブラウザーを導入してください。
- ContextStill: 任意の `CONTEXTSTILL_MCP_URL` とAPI keyを指定します。Streamable HTTP MCPの `search_knowledge` のみを呼び、DB共有やKnowledge登録をしません。同名Knowledgeも鮮度・根拠未確認なら外部で検証します。

`DATAFORSEO_MAX_REQUEST_USD` は1回の課金POSTの保守的な予約額です。利用する契約・価格に合わせて設定してください。Provider応答の費用で精算し、不明時は予約額を保持します。LLMのtoken予約は対応するbyte tokenizerを前提としたUTF-8 byte数＋最大出力＋message overheadで、usage不明時は予約額を保持します。別のtokenizerを使うProviderはこの上限が有効か事前に確認してください。金額予算は検索費用を対象とし、LLMの金額はモデル料金表が未設定のため含みません。

サーバーはloopbackに限定しています。インターネット公開・複数ユーザー認証を備えたサービスではありません。

## 出力と確認

UIから探索経路・採否理由・知見・引用元・実行イベントを確認できます。Citationは引用文、snapshot hash、UTF-16 offset、前後の文脈、原典URLを表示します。著者や公開日が取得できない場合は推定しません。

- DB: `data/deepstill.sqlite`
- 静的レポート: `data/artifacts/<jobId>/1/report.html`
- 根拠データ: 同じディレクトリの `evidence.json`
- 品質指標: `GET /api/jobs/<jobId>/metrics`。採否未確定の指標はnull。
- ローカル採否記録: `POST /api/jobs/<jobId>/candidates/<candidateId>/decision` に `{"adoption":"accepted"}` / `rejected` / `pending` を送信。ContextStillへの登録は行いません。
- ContextStill向け候補: `GET /api/jobs/<jobId>/candidates`。採用の自動登録はしません。

生成レポートは原文一致を確認したClaimを参照する章・段落で構成し、事実の整理と考察を区別します。各段落の参照IDを検証し、限界と未解決の問いも保存します。参照が存在しても推論が妥当とは限らないため、別の品質レビューが必要です。矛盾候補や弱い根拠はFindingsに残し、自動採用しません。原文一致は内容の真偽そのものを保証するものではありません。

## 設計・検証

設計書は [spec/](spec/README.md)、実装状況と制約は [実装記録](spec/implementation-status.md) を参照してください。

```sh
bun run docs
bun run verify
bun run verify:e2e
bun run evaluate       # 100件のfixtureによる復旧・引用経路の回帰評価
```

E2Eは初回のみ `bunx playwright install chromium` が必要です。verifyは型・lint・format・単体/契約テスト・build・文書lintを実行します。evaluateはlive調査品質やKnowledge採用率を測りません。実サービスでの品質評価はcredentialと人間によるレビューを伴う別の工程です。

## 実調査と改善

```sh
bun scripts/research.ts 'LLMと宗教'
bun scripts/review-research.ts <jobId>
bun scripts/revise-research.ts <jobId>
bun scripts/review-research.ts <jobId>
```

品質レビューは構造検証とluna / lowによる内容評価です。同じモデル系統の評価であり、人間や別モデルによる独立評価ではありません。新しいレビュー結果はDBのquality_reviewとoperationに残し、UIから確認できます。従来の `data/reviews/<jobId>/v<version>.json` は履歴として保持します。改稿前のArtifactも保持し、UIには最新バージョンを表示します。実行中に不足した論点を補うには `bun scripts/focus-research.ts <jobId> '追加クエリ'` を使用します。追加操作はイベントに記録されます。

Codexの内部コンテキスト・Web検索には固定上限を設定できないため、token予約は見積もりです。実usageで精算し、次の呼び出し前に残予算を確認しますが、単一呼び出しで超過する可能性があります。レビュー・改稿のCLIは稼働中workerへ処理を登録し、同じJob予算と実行枠を使用します。残り予算・時間が不足している場合は開始しません。Codex経路の検索費用0は「DataForSEO課金なし」を示し、購読利用やLLM処理が無料という意味ではありません。

## バックアップと復旧

```sh
bun run db:backup /absolute/path/to/new-backup.sqlite
```

WALを含む一貫したsnapshotを `VACUUM INTO` で作成し、integrity_checkを行います。出力先に既存ファイルがある場合は拒否します。復元はAPI/Workerを停止し、backupを新しいパスへコピーして `DATABASE_URL` を切り替え、migration・ready確認後に起動します。元DBは上書きしません。

Workerが異常終了した場合は再起動してください。30秒のlease期限後にtaskを回収します。保存済み外部応答は再利用し、応答未保存の課金requestはunknownとしてJobを停止します。Provider管理画面で課金・task IDを確認した後、必要なら新しいJobとして再実行します。

DB・secret・生成レポートはGit管理対象外です。ローカルSQLiteは同一ホスト上のディスクで使用し、ネットワーク共有ファイルに配置しないでください。

## レポート生成の品質管理（2026年9月12日更新）

実調査は、元の依頼条件に対するクエリ・検索結果・抽出Claimの範囲判定を行い、初稿生成、全文編集、品質レビューの順に処理します。形式名だけで対象を決めず、モードや適用条件を確認します。関連語の候補や手動追加クエリも、検索前に同じ判定を通ります。不明なクエリは条件確認に限定し、その検索から関連語を展開しません。判定はLLMによるもので、誤分類の可能性があり、保存済みscope記録で確認できます。

品質基準 `research-quality-v2` は依頼への適合、根拠、説明の深さ、構成、日本語、Knowledge・Episode抽出適性の7軸です。96点以上、全軸90%以上、重大な指摘なし、モデル判定passを自動通過条件とします。生成完了と品質通過は区別し、不足があれば本文を保存したうえでUIに「要改稿」と表示します。自動評価の通過は人間による品質確認や95点超の実証を意味しません。

追加の範囲判定・編集・レビューも実調査の使用量に含め、既存の予約・結果保存・再開処理で管理します。生成時には編集・レビュー分も見込んで探索を止めるため、同じ予算で取得できる資料数は減る場合があります。予算が不足した場合は部分終了になります。互換LLMの最大出力は抽出・判定・レビューが2048、初稿・編集が8192 tokensです。Codex経路の予約は引き続き見積もりで、厳密な出力上限ではありません。

本文候補には章の文脈と根拠を付け、Episodeには実行済み検索・結論・限界・未解決の問いを残します。新旧候補は版別に保持し、APIは最新版の候補のみ返します。複数版を持つ旧データの版未指定候補は最新版へ混ぜません。改稿すると新しい候補が作られ、過去の採否は自動で引き継ぎません。

`research:revise` は保存済み根拠を使う編集処理です。評価ファイルがあれば具体的指摘を使い、なければ全文編集します。評価は続けて `research:review` を実行してください。自動再調査、問い別の構成生成を独立した工程にすること、人間の見本による採点の校正は今後の拡張であり、この実装には含まれません。
