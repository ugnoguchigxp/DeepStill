# DeepStill v0.1 構成・依存パッケージ評価

確認日: 2026-09-12。初期構想（現在の [concept.md](concept.md)）全体、../hono-standard の README・package.json、および npm registry の latest metadata と配布 tarball の README・llm-fetch 型定義を確認した。ローカルの各ライブラリの README も参照したが、採用判断は公開版を基準とする。現在の実装順序・採用方針は[実装計画](plan.md)を正本とする。この文書は実装前の評価記録。導入後の結果は[実装記録](implementation-status.md)を参照。

## 採用方針

| 対象 | 方針 | DeepStillでの責務 |
| --- | --- | --- |
| hono-standard | authless構成を起点に必要部分を移植 | Hono API、React/Vite、Query、Zod、Drizzle、検証基盤 |
| llm-fetch 0.1.0 | Crawler Adapterの第一候補 | HTTP取得、本文抽出、取得内容のguard、必要時のPlaywright描画 |
| spec-html 0.1.6 | 開発用依存・ローカル成果物閲覧に利用 | 設計書、静的Research Artifactの閲覧・検査 |
| s11tnext 0.1.2 | LLM導入時に利用 | プロンプトの型付き管理、決定的render、manifestによる追跡 |

3パッケージは役割が異なるため併用できる。Frontier、Governor、Evidence、QueueはDeepStill自身が所有する。バージョンは固定し、更新時にAdapterの契約を検証する。

## hono-standardの再利用

Bun/Hono/React/Vite/Tailwind v4/TanStack Query/Zod/SQLite/Drizzleが計画と一致する。認証なしのローカルPoCには `template:authless` generator が適する。generatorは既存ディレクトリへの上書きを拒否するため、設計資料が存在するDeepStillを直接出力先にせず、新しい一時ディレクトリへ生成して移植する。

API・Web・共有schema・設定・検証scriptを `apps/api`、`apps/web`、`packages` へ配置し直す。import alias、Vite proxy、TypeScript設定、migrationパス、test対象、Dockerのコピー対象も併せて更新する。`.env`、DB、node_modules、認証サンプル、元プロジェクトのGit履歴は移植対象にしない。

最も大きな差はDBの並行実行契約。テンプレートのSingleWriterClientはプロセス内FIFOであり、READMEは複数プロセスによる同一SQLiteファイル利用を契約対象外としている。DeepStillではAPIとWorkerが書き込むため、そのままでは契約を満たせない。

同一ホスト・ローカルディスク上のSQLiteを前提に、WAL、busy_timeout、短いwrite transaction、上限付きbusy retry、原子的なtask取得を設計する。lease owner/tokenと期限を照合して完了を書き込み、期限切れの旧Workerが結果を確定できないようにする。再実行は冪等にし、migrationはAPI/Worker起動前の一箇所に集約する。プロセス内FIFOだけを複数プロセスの排他として扱わない。

## llm-fetch

公開版は `search()`、`read()`、`searchAndRead()` を提供する。HTTP取得とCheerioによる本文抽出、任意のPlaywright fallback、AbortSignal、期限、URL検証、prompt-injection guardがある。Bun 1.3.14以上が明記されている。

DeepStillでは `searchAndRead()` で一括実行せず、検索結果の重複除去・URL順位付け・予算予約を挟んで `read()` を呼ぶ。LLMへの自律tool公開は初期構成に不要。研究全体の探索順・停止・再試行・永続化はWorkerが制御する。

組み込み検索はDuckDuckGo/Braveとcustom provider。DeepStillの `suggest()`、Autocomplete、Related Searches、People Also Ask、DataForSEO Queueのsubmit/pollは提供契約に含まれない。DataForSEO Adapterは独立に実装し、llm-fetchを取得専用に使える。DuckDuckGoは手動PoCの補助候補だが、公開READMEでもbest effort扱いのため、評価用の安定基準にはしない。

`RetrievedDocument` にはURL/finalUrl/title/text/fetchedAt/fetchMethod/truncated/securityがある。一方、raw HTML、見出し構造、DOM selector、author、publishedAtはこの返却型にない。Mozilla Readabilityと同じ出力契約でもない。

v0.1では取得されたtextを不変snapshotとして保存し、そのhash、抽出器version、取得日時、finalUrlをSourceへ紐付ける。Evidenceはsnapshot ID、引用文、前後文、開始・終了offsetを持ち、offset単位も固定する。原文との一致を検証してからClaimへ接続する。これは取得時の抽出本文への追跡であり、元HTMLのDOM位置への追跡ではない。著者・公開日は不明ならnullとし、取得日で代用しない。

見出しによる分割や元HTML保存が必須なら、保存・構造化出力を追加するAdapter拡張、または安全なHTTP取得＋Readabilityを比較する。現在のread出力だけで実現できるとは扱わない。保存のための別fetchはページ差分が生じるので、同じ取得結果から保存と抽出を行う契約が必要。

`maxCharacters` はtoken予算ではなく、部分検索でもない。取得snapshotから関連箇所を選び、その後にLLM入力tokenを計測する。`truncated` を記録し、切れた資料を網羅的に読んだと判定しない。PDFなどは別Adapterが必要で、初期対象外なら理由付きで記録する。

guardのdeny/require_approvalは無効化して再取得せず、保留・除外理由を残して別Sourceへ進む。allowも根拠の正しさを保証しない。timeout、retryable error、browser未導入も型付き結果として保存する。ライブラリ内部のredirect/fallbackを含むHTTP回数と論理URL数は区別し、研究全体の時間・検索費用・token上限は別途Governorで制御する。

## spec-html

HTML/Markdownを扱うローカル文書viewerとCLIであり、クローラーやReact UI部品ライブラリではない。`spec/` の設計書と、出力済み `artifacts/<job>/<version>/` のローカル閲覧に適する。Markdownはそのまま表示できる。

Research Debuggerの進捗、停止、Frontier、Evidence drill-downはReactに実装する。DBのArtifact/Claim/Evidence/Sourceを正本とし、spec-html向けファイルはversion付きの派生出力にする。静的出力にもClaim ID、Evidence ID、引用文、原典URLを含め、相対リンクで辿れるようにする。viewer上の編集をDBへ暗黙に逆輸入しない。

HTML文書はinline scriptを実行する信頼済みローカル用途。取得したHTMLやLLMが自由生成したHTMLを直接表示しない。初期出力はMarkdown、またはアプリの固定テンプレートへescape済みデータを挿入したHTMLとする。文書lintはXSS sanitizerの代替ではない。

導入後の候補scriptは `bunx --bun spec-html ./spec --markdown-lang ja` と `bunx --bun spec-html check ./spec`。Mermaid/Chart.jsは必要な場合のみ追加する。

## s11tnext

Next.jsの基盤ではなく、プロンプトのruntime/compiler契約を提供する。公開runtimeはNode組み込みAPI・filesystem・TOML parsingを持たず、コンパイル済みartifactをcatalogへ渡して使う。編集・生成のCLIはruntimeとは別に検討する。

query expansion、snippet relevance、claim extraction、contradiction analysis、artifact synthesisをそれぞれ型付きcontextとして管理する。`bind()` / `bindRequest()` を使い、呼出し時のmanifestと実際に送ったrole/contentを対応させる。

取得本文はuntrusted変数とし、delimited-contextと非raw encoding（複数行本文にはdelimited-text）を使う。llm-fetchのguardと役割を分ける。s11tnextはLLM Provider、token計数器、出力検証器、事実検証器ではない。出力はZodで検証し、引用箇所の原文一致を別途確認する。

研究実行履歴にはprompt manifest/hash、model/provider、生成設定、Source snapshot ID、token使用量、LLM応答を関連付ける。同一プロンプトの再構成と追跡に使えるが、同一回答や事実の正しさを保証しない。公開enginesはNodeを指定しているため、Bunでcatalog生成・render・hashのsmoke testを行ってから採用を確定する。

## 実装順と検証

1. authless雛形を新規一時ディレクトリに生成し、生成元のbaselineを検証してからapps/packagesへ移植する。
2. SQLite task lease・Governor・mock providersを実装する。2プロセスの同時取得、lease切れ、旧Workerの完了拒否、再試行時の重複、予算競合を確認する。
3. llm-fetch Adapterを追加する。固定fixtureでredirect、文字化け、truncation、guard拒否、timeout、引用offsetを確認。動的ページはbrowser有無の両方を検証する。
4. DataForSEOとs11tnextを接続する。費用を伴う実APIと分離して、credential不要のprovider stubでsubmit/poll・キャンセル・schema検証を行う。
5. Artifact→Claim→Evidence→SourceのUIと静的exportを実装する。再起動後の継続・SSE再接続・引用リンク・HTML escapeを確認する。

移植後の品質gateは元構成に合わせ `bun run verify` と `bun run verify:e2e` を整備し実行する。追加の検証は研究固有の予算・lease・引用整合性に集中する。この評価時点では未検証。導入後の検証結果は実装記録に分離して記載する。

Crawlerは同じ資料群で従来fetch＋Readabilityと比較する。抽出成功率、引用再現率、本文欠落、処理時間、browser移行率、LLM入力token、guardによる保留率を測り、導入可否を判断する。

## 一次資料

- [llm-fetch 0.1.0 metadata](https://registry.npmjs.org/llm-fetch/0.1.0) / [公開パッケージ](https://registry.npmjs.org/llm-fetch/-/llm-fetch-0.1.0.tgz)
- [spec-html 0.1.6 metadata](https://registry.npmjs.org/spec-html/0.1.6) / [公開パッケージ](https://registry.npmjs.org/spec-html/-/spec-html-0.1.6.tgz)
- [s11tnext 0.1.2 metadata](https://registry.npmjs.org/s11tnext/0.1.2) / [公開パッケージ](https://registry.npmjs.org/s11tnext/-/s11tnext-0.1.2.tgz)
- ローカル構成: ../hono-standard/README.md、../hono-standard/package.json

npmのWebページは403だったため、公式registryと配布物を直接確認した。
