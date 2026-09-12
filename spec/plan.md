# DeepStill v0.1 実装計画

更新日: 2026-09-12。状態: 単体PoC実装・ローカル検証済み。実サービス接続と実調査の品質評価は残件。[実装記録](implementation-status.md)を参照。

次期探索の変更計画は[逐次キューと回答価値に基づくラウンド探索](round-research-plan.md)を正本とする。初回の一括クエリ拡張、固定score中心の選択、新規Claim増分中心の停止判定は、同計画の実装時に置き換える。v2の実装・固定経路検証は完了し、具体化した契約と未実測項目は[実装記録](round-research-implementation.md)を参照。

[設計資料一覧](README.md) / [コンセプト](concept.md) / [依存パッケージ評価](dependency-evaluation.md)

## 1. 実現すること

DeepStillは、指定されたテーマを時間と費用の上限内で探索し、重要な記述から外部の原典へ遡れるResearch Artifactを生成する。毎回検索をやり直す代わりに、一度調査した成果を保存して再利用する。

最初の利用体験は「テーマと予算を入力する → 探索状況と採否理由を確認する → 根拠付きレポートを読む → 引用から取得時の本文と原典URLへ移動する」とする。長時間の処理はWorkerで実行し、API・UIの再起動やWorkerの異常終了から復旧できるようにする。

ContextStillは調査する価値の判断とKnowledgeの採用を担当する。DeepStillは外部調査と候補生成を担当し、DBを共有しない。ContextStill未接続でも、手動入力と空のKnowledge Providerで全工程を実行できる。

## 2. 実装で守る条件

- Artifactの事実記述はClaim、Evidence、Source snapshotへ接続する。未検証の推論はその旨を表示し、裏付けのある事実として採用しない。
- ContextStillのKnowledge、Episode、VibeはSeed・文脈・仮説に使い、外部Evidenceとして扱わない。
- 検索と重複除去で候補を絞り、LLMには関連箇所だけを渡す。
- FrontierはQueryのGraphとして保存し、優先順位の高い候補から探索する。
- Governorは新しい仕事の開始前に予算を判定する。飽和検出に加えて必ず上限を設ける。
- 状態、予算、task、根拠関係はDBを正本とする。UI、SSE、静的出力は保存済み状態から構成する。
- 検索、Crawler、LLM、ContextStillをAdapterで分離する。Coreは特定サービスやDBに依存しない。

## 3. v0.1の範囲

| 含めるもの | 初期の深さ |
| --- | --- |
| Job作成・一覧・詳細・停止 | テーマ、Seed、予算、状態、終了理由 |
| Knowledge Check | known / verify / explore判定、未接続時の明示 |
| Query Frontier | 正規化、重複除去、親子以外の関連edge、scoreと採否理由 |
| 検索 | DataForSEO優先。AutocompleteとOrganicを必須の接続対象とする |
| 取得 | HTMLの静的取得、必要時のPlaywright fallback |
| Evidence / Claim / Finding | 原文一致検証、根拠との関連、重複・矛盾・弱い根拠の区別 |
| Artifact | 保存済みClaimに基づくレポート、引用、version |
| 出力候補 | KnowledgeCandidateとEpisodeCandidate。ContextStillへの直接登録はしない |
| Research Debugger | Dashboard、Frontier一覧、Findings、Artifact、Evidence詳細 |
| 復旧・監視 | SQLite lease queue、予算台帳、イベント、再起動からの復旧 |
| 戦略比較 | strategy ID/versionと同じ条件で比較できる計測記録 |

Related Searches / People Also AskはProvider側の対応を確認して拡張する。LLMによるQuery拡張は基本経路が成立した後の比較戦略とする。高度なGraph描画は必須にせず、関連が辿れる一覧から始める。

PDF抽出、OCR、Bun.WebView実装、定期再調査、Vibe自動監視、大規模分散Worker、Redis/Postgres、Tauri、Knowledge自動採用はv0.1に含めない。対象外の資料は取得失敗と混同せず理由を記録する。

## 4. 技術と配置

Bun、Hono、React/TypeScript/Vite、Tailwind CSS v4、TanStack Query、Zod、SQLite/Drizzleを採用する。UI部品はhono-standardから利用可能なものを移植し、不足する場合にshadcn/uiを追加する。

| 対象 | 方針と境界 |
| --- | --- |
| hono-standard | authless生成物から基盤を移植。既存DeepStillへの上書き生成はしない |
| llm-fetch 0.1.0 | Crawler Adapterの第一候補。構造・根拠保存の契約テスト後に確定 |
| spec-html 0.1.6 | 開発依存。spec/の閲覧・検査と静的レポートのローカル閲覧 |
| s11tnext 0.1.2 | LLMプロンプトのrenderとmanifest。Bun互換smoke後に確定 |
| DataForSEO | Search Adapter。APIごとの同期/Queue対応と料金を接続実装前に公式仕様で確認 |
| LLM Provider | LARM互換Adapter。接続仕様、model、usage取得方法を実装時に確認 |

上記のパッケージversionは前回調査時の候補を固定したもの。APIを推測して実装せず、公開型と契約テストで確認する。採用不能の場合は理由と代替案を依存評価へ追記する。

```text
deepStill/
├── spec/                       設計書・実装計画
├── apps/
│   ├── api/                    HTTP、SSE、入力検証
│   ├── worker/                 task実行、Adapter接続、復旧
│   └── web/                    Research Debugger
├── packages/
│   ├── core/                   job、frontier、governor、evidence、finding
│   ├── contracts/              API・イベントの共有schema
│   ├── db/                     schema、migration、queue、repository
│   ├── crawler/                llm-fetch Adapter、section選択
│   ├── search-provider/        mock、DataForSEO
│   ├── llm-provider/           mock、LARM互換Adapter
│   ├── prompts/                s11tnext catalogと生成設定
│   ├── artifact/               引用検証、静的export
│   └── integrations/contextstill/
├── scripts/                    bootstrap、verify、評価コマンド
└── data/                       Git管理対象外
    ├── deepstill.sqlite
    └── artifacts/<jobId>/<version>/
```

APIとWorkerは別プロセスにする。v0.1は同一ホストのローカルSQLiteファイルを使用し、複数ホスト共有やネットワークファイルシステムを前提にしない。開発時は `bun run api`、`bun run worker`、`bun run web` で独立起動できる状態を目指す。

## 5. 処理の流れ

1. テーマ・Seed・予算を検証し、Jobと最初のtaskを同じtransactionで作成する。
2. Knowledge Providerで既知情報を確認し、調査すべき差分を設定する。未接続は「未知であると確認済み」と区別する。
3. Autocompleteなどから候補を取得し、Query正規化とdedupを行ってGraphへ保存する。
4. KnowledgeGap、Novelty、EvidenceNeed、Diversityなどのscoreと理由を保存し、上位Queryを選ぶ。重みとtie-breakをversion管理する。
5. 検索結果を正規化し、既取得URL、関連性、一次資料優先、domain多様性で取得対象を絞る。
6. Governorで予算を予約してCrawlerを呼び、取得snapshotと取得結果を保存する。
7. snapshotを段落単位に分け、keyword/FTSなどで関連箇所を選ぶ。見出し構造を取得できるAdapterでは見出しも使う。embeddingは必要性を測って追加する。
8. LLMでEvidence候補とClaimを抽出し、引用の原文一致とschemaを検証する。不一致は採用しない。
9. Claimの重複・支持・矛盾を整理してFindingにする。新しい概念は次roundの候補へ返す。
10. roundごとに情報増分と消費量を判定し、続行または終了する。
11. 検証済みClaimからArtifactと候補を生成し、引用整合性を確認してversionを確定する。

検索から取得までを一括処理する `searchAndRead()` は通常経路では使わない。間に予算、dedup、順位付けを挟む。LLMへ無制限の探索toolを渡さない。

## 6. 保存契約

| Entity | 保存するもの・整合性 |
| --- | --- |
| ResearchJob | Seed、設定snapshot、strategy version、status、終了理由、時刻 |
| QueryNode / QueryEdge | 正規化Query、depth、score、採否理由、探索状態、edge由来 |
| SearchRequest | Provider、request/task ID、Query、状態、送信条件、費用・試行記録 |
| Source / SourceSnapshot | 要求URL・finalUrl、取得日時、本文、hash、抽出器version、truncated、guard結果 |
| Evidence | snapshot ID、引用文、前後文、start/end位置 |
| Claim / ClaimEvidence | 主張、confidence、支持/矛盾edge。confidenceだけで採用しない |
| Finding | NEW / KNOWN / DUPLICATE / CONTRADICTION / WEAK_EVIDENCE。採否と理由は別field |
| LlmInvocation | prompt manifest、role/contentの識別情報、model設定、入力snapshot、応答、usage |
| ResearchArtifact / ArtifactClaim | body、version、Claim参照、生成状態、引用検証結果 |
| KnowledgeCandidate / EpisodeCandidate | 採用候補と根拠、ContextStillに返す識別情報 |
| ResearchTask / BudgetLedger / JobEvent | lease、再試行、予算予約・消費、順序付きイベント |

v0.1の引用位置は保存した抽出本文に対するUTF-16 code unitの半開区間 `[start, end)` とし、`text.slice(start, end) === quote` を必須とする。hashは保存本文をUTF-8で符号化した値から計算する。検索用に正規化した本文を引用位置の正本にしない。

llm-fetchのread結果は元HTMLやDOM selectorを返さないため、v0.1で保証するのは「取得時の抽出本文」と原典URLへの追跡。元HTMLの位置復元は保証しない。著者・公開日が不明ならnullとする。Sourceの再取得は新しいsnapshotとし、過去のEvidenceを上書きしない。

## 7. 予算・停止・復旧

初期の設定例はQuery数50、異なる取得対象URL数100、LLM解析対象文書数20、全LLM token数100,000、depth 5、wall time 2時間。用途に応じて変更可能にする。

Query数とは別にsuggest/search/submit/pollの実リクエスト数、取得の試行数、LLM再試行、費用を記録し上限を設ける。Provider費用が不明な場合は推定と明記し、判明した金額で精算する。redirectやbrowser内通信など観測できない内訳を正確に計測済みとして扱わない。

予算はDB transactionで `消費済み + 予約済み + 今回の最大消費 <= 上限` を確認して予約する。LLMは入力tokenと最大出力tokenを予約し、実usageで精算する。usage不明のtimeoutはゼロ消費として解放せず、上限見積もりを保持する。Provider側にも出力上限・期限を渡す。正確な計数や上限を契約できないProviderは、その制約を明示して適合するAdapterを選ぶ。

探索予算と最終Artifact生成用のtoken/timeを分けて予約する。探索停止後に生成予算が残れば部分成果をレポート化し、不足なら構造化したFindingsまでを保存する。Job全体の期限を超えて生成を続けない。

情報増分は「新規で、外部Evidenceが検証済みかつ重複でないFinding」のround間増分を基本とする。飽和閾値、連続低増分round数、最低round数、cost単位を設定へ保存する。Provider失敗だけのroundを知識飽和と判定しない。Knowledgeの実採用率とは別の指標にする。

Job状態は queued → running → finalizing → completed を基本とし、cancel_requested → cancelled、failedを持つ。budget_exhausted、saturated、frontier_emptyなどは終了理由として記録する。completedはArtifactの引用検証・保存が完了した場合に限り、生成できない部分成果は別のpartial状態として扱う。

SQLiteのtask取得は原子的に行い、lease token/owner/期限を更新する。heartbeatで延長し、完了時もtokenと期限を照合する。処理結果の保存と次task作成は同じtransactionに入れる。期限切れWorkerの書込み拒否と一意キーで重複確定を防ぐ。HTTP/LLM呼出し中にDB transactionを保持しない。

外部APIの実行とローカルDB保存は原子的にできない。送信前intentとProvider task IDを保存し、再起動時は既存taskを照会する。結果不明な課金requestを無条件再送しない。照会・冪等キーがない場合はunknownとして保留し、予算を保守的に消費扱いする。

停止要求は保存してWorkerへ伝え、新規taskを開始しない。実行中の処理はAbortSignalで中断し、遠隔taskを取消できない場合も以後の採用・課金状態を記録する。再開は永続taskからの復旧を意味し、ユーザー操作による任意pause/resume UIは初期必須にしない。

## 8. 外部サービスと表示の境界

DataForSEOのQueue待ちは永続taskとnextAttemptAtで管理し、Workerを長時間sleepさせない。全endpointが同じQueue契約だと仮定しない。retryは回数・backoff・期限を持ち、429や一時障害と入力不正を区別する。

Crawlerのguard拒否は記録して別Sourceへ進む。allowでも取得本文はuntrustedのまま。browser未導入、本文不足、未対応形式は区別する。既定の安全なtransportを置き換える場合、その契約と検証もAdapterの責務にする。

s11tnextのcontextには固定instructionとuntrustedな引用入力を分離して定義し、schemaによる出力検証はDeepStillで行う。hashは入力の追跡に使い、出力の再現性・正しさを保証する値として扱わない。

ContextStill Adapterの初期契約は既知情報lookupとCandidate出力。接続仕様が未確定でもMockで開発を継続する。採用結果の受取りは明示的な契約を設け、未取得の採用率は0%ではなく未計測とする。

React APIはJob作成/一覧/詳細/停止、Frontier、Finding、Artifact、Evidence/Source、イベントを提供する。SSEは永続event IDで再接続し、取りこぼし時はDBから再取得する。ブラウザー接続の有無でWorkerを止めない。

spec-html向けにはMarkdownまたは固定テンプレートにescapeしたHTMLを出力する。取得HTMLやLLM生成scriptを直接実行しない。ArtifactはClaim/Evidence/Source IDと原典URLを持ち、DBを使わず静的ファイルだけでも引用を辿れる構成にする。

## 9. 段階別の実装計画

M0〜M5の単体PoCを実装し、外部通信なしの検証を実施。live接続を伴う完了条件は未確認であり、各段階全体の達成とは分けて扱う。具体化による差分は実装記録に記載する。

### M0: 起動・検証できる基盤

- [x] hono-standardのauthlessを新規一時ディレクトリに生成し、baselineのverify/E2E結果を記録する。
- [x] apps/packages構成へ移植し、API/Web/Workerの独立entry、共有schema、migration実行口を用意する。
- [x] secret・DB・node_modulesをコピーせず、DeepStill用metadataと環境変数例を整える。
- [x] spec-htmlを開発依存として固定し、docs/docs:checkをspec/へ向ける。
- [x] verify、verify:e2e、CIとfresh setup手順を整える。

完了条件: fresh環境から設定例のみでAPI health、空Dashboard、Worker起動が確認でき、型・lint・format・test・build・基本E2Eと文書checkが通る。

### M1: 外部通信なしで安全に仕事を実行

- [x] Core Entity、DB schema/migration、lease queue、Job状態、予算台帳、イベントを実装する。
- [x] deterministicなSearch/Crawler/LLM/KnowledgeのMockを用意する。
- [x] 最小縦断経路として「Job → task → 固定Source → Evidence → Claim → 固定Artifact」を永続化する。
- [x] 停止、期限切れ、予算予約、再試行、冪等な結果確定を実装する。

完了条件: credentialなしで1件完了。別プロセスの競合、Worker killと復旧、古いleaseによる書込み、予算境界での同時予約を実DBで検証し、二重確定と上限超過が起きない。Artifactからsnapshotまで辿れる。

### M2: Frontierと検索

- [x] Query正規化、Graph、score、best-first選択、domain多様性、round評価を実装する。
- [x] Mockで候補の循環・重複・既知・矛盾を含む探索を検証する。
- [x] DataForSEOのAutocomplete/Organic接続を公式仕様で確認し、同期/Queue処理を実装する。
- [x] request ID、送信intent、poll、timeout、retry、費用記録を永続化する。

完了条件: 上位候補だけが探索され、同じ入力・strategyで選択を再現できる。候補枯渇・飽和・障害・予算停止を区別する。Provider stubで再起動中のsubmit/pollと結果不明を検証し、live接続は明示的な任意実行で別記録する。

### M3: Crawlerと再検証できるEvidence

- [x] llm-fetch Adapter、静的取得、Playwright fallback、結果分類を実装する。
- [x] snapshot保存、hash、段落分割、関連箇所選択、引用offset検証を実装する。
- [ ] 実資料に近いfixture群でfetch＋Readability案と比較し、本文欠落・引用再現性を判断する。（小規模fixtureでの比較のみ実施済み）
- [x] truncation、重複取得、encoding、redirect、guard拒否、browser未導入を検証する。

完了条件: 採用Evidenceは全件snapshotと完全一致し、再取得で壊れない。長文は関連箇所へ絞られ、拒否された内容がLLMに渡らない。構造情報不足が許容できなければ採用判断と取得契約を修正してから次へ進む。

### M4: LLMによる知見とレポート

- [x] s11tnextのBun smokeとプロンプトcatalog、LARM互換Adapter、usage記録を実装する。
- [x] Claim抽出、重複判定、支持/矛盾整理、Finding分類を実装する。
- [x] Artifact生成、引用検証、version確定、Knowledge/Episode Candidate出力を実装する。
- [x] 不正JSON、存在しない引用、根拠不足、usage不明、生成予算不足を処理する。

完了条件: LLM応答を無条件採用せず、重要な事実記述のClaim参照を検証する。未検証項目を事実として公開しない。prompt・model・入力根拠を追跡できる。credential不要の異常系テストと小規模live検証を区別して記録する。

### M5: Research DebuggerとArtifact閲覧

- [x] Topic入力、予算設定、Dashboard、停止操作を実装する。
- [x] Frontierの選択理由、Findingsの採否、CitationからEvidence・Sourceへの遷移を実装する。
- [x] SSE再接続と履歴復元、部分成果・失敗理由の表示を実装する。
- [x] version付き静的exportとspec-htmlによる閲覧を整える。

完了条件: E2EでJob作成から引用閲覧まで完了する。リロード・再接続でも状態が一致し、停止が反映される。静的exportの相対リンクが成立し、外部HTMLを実行しない。

### M6: ContextStill接続とPoC評価

- [ ] lookup契約とCandidate形式を実endpointで確認する。（MCP Adapterと未接続・通信失敗処理は実装済み）
- [x] 実DB共有なし、Knowledge直接登録なしを確認する。
- [x] strategy/config/provider/model/prompt versionと評価データを揃えて比較する。
- [ ] 100件以上の実Research Jobを蓄積し、品質指標と費用、失敗内訳を評価する。（fixture 100件の回帰評価は実施済み）

完了条件: 全採用候補が外部Evidenceを持ち、無限探索がない。運用復旧手順を実演できる。品質目標の達否と未計測値をレポート化し、正式統合・改善・見送りを判断できる。

## 10. 評価と完了の判定

実装の機能完了と研究品質の達成を分ける。M5までで単体PoCの機能完了、M6でContextStill統合と品質評価を行う。

| 指標 | 定義・目標 |
| --- | --- |
| Novel Finding Rate | NEW Findings / 全Findings。PoC目標 >30% |
| Knowledge Adoption Rate | 採用数 / 採否が確定した候補数。判定済み割合も併記。PoC目標 >15% |
| Duplicate Rate | DUPLICATE Findings / 全Findings。PoC目標 <40% |
| Token Efficiency | 採用数 / 使用token数 ×100,000。採否不明なら未計測 |
| Search Efficiency | 有用Finding数 / 検索request数。suggest/pollなど内訳を併記 |
| Evidence Coverage | 採用候補の外部Evidence接続率100%、Artifactの事実記述の引用整合性100% |
| 停止と復旧 | 無限探索ゼロ。再試行後も二重確定なし |

分母0は未計測とする。戦略比較は同一テーマ・予算で行い、検索時点の差を記録する。固定fixtureによる回帰検証とliveな情報品質評価は混ぜない。正しさ・有用性は人間によるsample reviewも行い、LLMの自己採点だけで判断しない。

## 11. 検証コマンドと運用成果物

以下のコマンドを実装済み。

```sh
bun run verify          # typecheck / lint / format check / tests / build
bun run verify:e2e      # mockによるUI縦断と停止・再接続
bun run docs:check      # spec/内の文書・参照整合性
```

追加のlive検索・LLM・browser検証は別コマンドに分け、networkやcredentialのないCIでも基本gateが成立するようにする。段階ごとの契約テストは通常のverifyに含める。移植前後のbaseline比較、DB backup/restore、migration、Worker停止・再開、失敗Jobの診断手順を残す。

次の評価工程は接続設定後の小規模live検証と、実調査100件の品質評価。単体PoCの起動・運用方法はREADMEを参照する。
