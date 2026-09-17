# ContextStill 汎用探索 plugin 接続に向けた DeepStill 境界設計

作成日: 2026-09-17

## 1. 結論

ContextStill 側の指摘は、方向として妥当である。DeepStill はすでに独立した API、永続 job、worker、探索 engine、Report、claim、evidence、Memory を持つため、ContextStill へ移植するのではなく、ContextStill が将来所有する汎用 ResearchEngine protocol を実装する adapter を DeepStill 側に置くのが最小である。

ただし、現時点で ContextStill 固有 endpoint や最終 wire schema を DeepStill に実装してはいけない。先に行うべきことは、既存の Web 探索処理を壊さずに、次の内部境界を抽出することである。

- protocol request を内部 job input へ変換する submit port
- 内部 job の状態を protocol 非依存の状態へ写像する lifecycle port
- Report、claim、evidence、Memory を外部 bundle 候補へ投影する result port
- Web 固有の URL と snapshot を、connector 非依存の resource identity と locator へ投影する provenance port
- ContextStill Knowledge 読み取り client と、将来の plugin adapter の分離

最初の実装対象は interface、型、deterministic fixture、mapping test に限定できる。submit の冪等性、ACK、retention、外部 source connector の実行は永続状態を必要とするため、ContextStill contract の方向が合意されてから別 migration として実装する。

## 2. 確認した現行構造

### 2.1 API と job lifecycle

`packages/contracts/index.ts` の `createJobSchema` は、topic、mode、strategy、seed、budget、engineVersion を受ける standalone 用契約である。`apps/api/app.ts` は作成、詳細、cancel、resume、Report、候補、Memory、event stream を公開する。API は loopback だけを許可し、全 `/api/*` body を 16 KiB に制限する。

`packages/db/index.ts` は job と task を SQLite に永続化し、lease 期限切れ後の再取得、operation の intent / done / unknown、budget reservation、cancel、resume を扱う。同じ job の再起動安全性は強いが、外部 submit request の idempotency key と request hash は持たない。

現行 status は次である。

- queued
- running
- finalizing
- completed
- partial
- cancel_requested
- cancelled
- failed

worker は task lease と単一 execution slot を使う。保存済み operation result は再利用し、外部結果が不明な operation は自動再送しない。cancel は idle task なら即時 cancelled、実行中なら cancel_requested とする。resume は cancelled、failed、partial に限定し、完了済み operation と予約済み usage を保持する。

この lifecycle は plugin adapter の土台になる。ただし、host が期待する「同一 submit の同一 job 解決」「result import ACK」「保持期限」は別概念であり、現行 lifecycle だけでは満たさない。

### 2.2 engine と provider 境界

`apps/worker/engine.ts` の `Providers` は search、crawler、llm、knowledge を注入する。LLM、検索、crawler、Knowledge は adapter 化されているが、ResearchEngine 自体の port は定義されていない。round engine と deliverable engine は Web URL、crawl、snapshot を直接扱うため、探索判断と Web source access は実装上まだ密結合している。

`packages/llm-provider/index.ts` の `CompatibleLlm` は非 streaming の OpenAI chat completions 必要部分だけを使う。ContextStill が将来 LLM Gateway を提供する場合、transport の再利用余地はある。ただし request correlation、retryable error の分類、論理 model、prompt manifest hash は現行 interface にない。

### 2.3 ContextStill 連携

`packages/integrations/contextstill/index.ts` の `ContextStillMcp` は `search_knowledge` だけを read-only で呼ぶ `KnowledgeProvider` である。接続失敗は unavailable、未接続は disconnected として standalone を維持する。この分離は妥当だが、lookup input は query と signal だけであり、repository identity や tenant scope を渡せない。

この package は現在、Knowledge read client であって ResearchEngine plugin adapter ではない。同じ directory に置く場合も、少なくとも次の module に分けるべきである。

```text
packages/integrations/contextstill/
  knowledge-client.ts       # 現行 ContextStillMcp
  knowledge-contract.ts     # read-only port
  plugin-adapter.ts         # 将来の host protocol 実装
  plugin-mapping.ts         # protocol と内部型の変換
```

`packages/memory/index.ts` の `contextStillExport` は `contextstill-dry-run-v1` を生成する。Knowledge の canonical object と evidence refs、UTF-8 range を含むが、write は行わず、Episode mapping は未確定と明記する。これは候補変換の診断出力であり、job result contract、登録完了、互換確認済み schema のいずれでもない。

### 2.4 Report、claim、evidence、Memory の生成元

- claim と evidence は crawler snapshot から抽出され、evidence は snapshot ID、quote、UTF-16 start / end を持つ。
- Report は accepted claim を参照する artifact として生成される。
- Memory は Report ではなく accepted claim、evidence、保存 event を入力に生成される。
- Knowledge 候補は Memory の rule / procedure から生成できる。
- Episode は保存 event を主な入力に生成され、Report の言い換えを source of truth にしない。
- `validateMemory` と `drillMemory` は dangling reference、snapshot hash、quote、offset を照合する。

したがって「Report をそのまま外部根拠にしない」という指摘は、現行設計と一致する。外部 bundle では Report を補助成果物、claim と原 source locator を provenance として分けるべきである。

### 2.5 品質評価履歴

`docs/handoffs/research-quality-reset/START-HERE.md` と `TRIAL-HISTORY.md` は、schema 適合やテスト通過だけを品質改善とみなさず、query、URL 選定、取得内容、token、正常終了、Report、Knowledge、Episode を一続きで比較するよう要求する。現行基準は合格版ではなく、探索品質には未解決の回帰がある。

plugin 化によって現在の品質を暗黙に保証したり、ContextStill 経由であることを改善と扱ったりしてはいけない。統合評価は contract 正当性と研究品質を別々に判定する。

## 3. ContextStill 側指摘の妥当性

| 指摘 | 判定 | 根拠と扱い |
|---|---|---|
| 独立 repository、共有 DB・submodule 禁止 | 妥当・必須 | 現行の standalone 構造と一致する。 |
| `createJobSchema` へ ContextStill field を追加しない | 妥当・必須 | standalone API と host protocol の変更速度を分離できる。 |
| ResearchEngine と SourceConnector を分ける | 妥当だが未実装 | provider interface はあるが、engine は Web URL / snapshot と密結合している。 |
| capabilities、submit、status、result、cancel、ACK | 妥当 | status と cancel は再利用可能。submit 冪等性、ACK、retention は新規。 |
| target budget と hard safety ceiling を分ける | 妥当だが意味論調整が必要 | 現行 budget は transaction で強制される hard cap。品質方針上の soft target は別型・別判定にすべき。 |
| HTTP URL 以外の locator | 将来性だけでなく設計上必須 | Slack、Confluence、SharePoint connector を使うには URL 主体の Snapshot / Hit から抽象化が必要。 |
| optional host capability | 妥当 | LLM、Knowledge read、source connector、audit を個別 negotiation し、不在時は standalone provider を使う。 |
| result retention と ACK grace period | 妥当だが migration 待ち | 現行は手動 delete まで保持され、期限・ACK state がない。 |
| completed / partial / failed / cancelled の定義 | 必須 | 現行 partial は成果物品質不足、予算、外部結果不明など複数の意味を含む。protocol では reason と result availability を分離する。 |
| deterministic fixture と改ざん検出 | 妥当・先行可能 | 現行 hash / locator 検証を再利用できる。 |
| `CompatibleLlm` の ContextStill Gateway 利用 | 技術的には可能、優先度は低め | ResearchEngine contract の成立条件ではない。provider lease と認証を伴うため ContextStill 側実装の影響が大きい。 |

## 4. ContextStill 現行設計へ返す修正要求

ContextStill の `spec/docs/deepstill-v1-integration-design.html` は多くの点で妥当だが、そのまま確定してはいけない。

### 4.1 protocol ownership の矛盾

同文書の contract 管理節は DeepStill を protocol owner としている。これは「汎用 ResearchEngine protocol は ContextStill 側が所有し、DeepStill は adapter 実装を所有する」という今回の原則と矛盾する。

推奨は次である。

- ContextStill が host-facing ResearchEngine / SourceConnector contract と version policy を所有する。
- DeepStill は対応 version range、capabilities、request / result mapping を所有する。
- DeepStill repository に置く schema は上流 contract の複製または adapter fixture であり、汎用 protocol の正本ではない。
- 双方の CI は同じ fixture corpus を検証するが、npm package や内部型は共有しない。

### 4.2 Web V1 と汎用 source contract の混同

同文書は source URL を HTTP(S) に限定する。一方、将来 contract は Slack message、Confluence section、SharePoint item を表現する必要がある。

HTTP(S) 制限は DeepStill V1 の `web` connector capability にだけ適用する。汎用 locator schema は connector kind ごとの opaque locator を許し、protocol 共通層で URL を必須にしない。未知 scheme の自由文字列を許すのではなく、connector kind と locator kind の組み合わせを capabilities で宣言する。

### 4.3 ContextStill 専用 endpoint の先行確定

同文書の `/api/integrations/contextstill/v1/*` は具体的すぎる。現在は contract が未確定なので、DeepStill 側では HTTP route を作らず、transport 非依存の adapter port と mapping fixture を先に作るべきである。endpoint path、認証、callback / polling、status code は ContextStill contract 決定後に薄い transport として追加する。

### 4.4 LLM Gateway を最初の PR にする順序

LLM Gateway は便利だが、汎用探索 plugin 境界の前提ではない。provider lease、resident writer、認証、abort、quota、usage correlation を同時に変更し、ContextStill 側の blast radius が大きい。

最初は DeepStill の direct provider と deterministic fixture のまま、手動 submit / status / result mapping を検証する。その後に LLM Gateway を独立した optional capability として比較する方が、plugin lifecycle と provider routing の不具合を分離できる。

### 4.5 target budget の意味

DeepStill の現在の budget は超過前に operation を拒否する hard cap である。ContextStill 設計の target 超過許容をそのまま既存 budget へ写すと、現行安全性を弱める。

adapter request は soft target と host hard ceiling を受け取ってよいが、内部 job へは次のように変換する。

- 既存 `Job.budget` は常に強制可能な internal hard cap として維持する。
- soft target は job config の policy hint として別保持し、次 action / stop decision の入力にする。
- host hard ceiling、DeepStill deployment ceiling、field schema max の最小値を internal hard cap にする。
- target 超過は usage annotation、hard cap 超過は operation 拒否として区別する。

## 5. 推奨する内部 port

以下は protocol の正本ではなく、DeepStill 内部を host contract から隔離するための概念型である。

```ts
interface ResearchEngineAdapter {
  capabilities(): Promise<EngineCapabilities>;
  submit(request: AdapterSubmitRequest): Promise<AdapterJobRef>;
  status(jobId: string): Promise<AdapterJobStatus>;
  result(jobId: string): Promise<AdapterResultEnvelope>;
  cancel(jobId: string): Promise<AdapterJobStatus>;
  acknowledge(jobId: string, resultHash: string): Promise<AckResult>;
}

interface InternalResearchPort {
  create(input: InternalJobSubmission): Promise<{ jobId: string }>;
  read(jobId: string): Promise<JobDetail | null>;
  cancel(jobId: string): Promise<Job | null>;
}

interface SourceConnector {
  capabilities(): SourceCapabilities;
  search(input: SourceSearchRequest, signal: AbortSignal): Promise<SourceHit[]>;
  fetch(input: SourceFetchRequest, signal: AbortSignal): Promise<ResourceSnapshot>;
}
```

`ResearchEngineAdapter` は host protocol を実装する層、`InternalResearchPort` は既存 Store / worker を包む層、`SourceConnector` は engine が使う resource access 層である。HTTP handler、MCP、CLI はこの外側に置く。

## 6. ResearchEngine と SourceConnector の分離可能性

### 6.1 ResearchEngine に残す責務

- 問いと requirement の分解
- query / source request の生成
- 探索順序と次 action の選択
- claim / evidence relation の構築
- Report、Memory、Knowledge / Episode 候補の生成
- soft target、hard cap、停止判断、unresolved question
- source の価値、重複、独立性の評価

### 6.2 SourceConnector に移す責務

- query の実行
- opaque resource の取得と fragment 読み取り
- revision / canonical identity の提供
- connector instance、tenant / container scope の提供
- visibility / authorization scope reference の提供
- provider rate limit、認証、retryable failure の分類

### 6.3 現行 Web 実装からの移行

V1 は Web search と crawler を内蔵したままでよい。最初に `Hit.url` と `Snapshot.url/finalUrl` を全面置換せず、次の投影型を追加する。

```ts
interface ResourceIdentity {
  connectorKind: "web" | string;
  connectorInstanceId: string;
  resourceId: string;
  revision?: string;
  scope?: Record<string, string>;
  displayUrl?: string;
  visibilityRef?: string;
}

interface FragmentLocator {
  kind: "utf8_bytes" | "utf16" | "message" | "section" | string;
  value: Record<string, string | number>;
}

interface EvidenceLocator {
  resource: ResourceIdentity;
  fragment: FragmentLocator;
  snapshotHash: string;
  quoteHash: string;
}
```

Web adapter は canonical URL を resource ID、snapshot hash を revision 補助、UTF-8 byte range を canonical fragment として投影できる。既存 UTF-16 offsets は内部引用検査と UI 用に残す。

外部 connector を engine へ注入するには、URL を直接生成・選択する prompt / state を `SourceCandidate` と opaque locator に変える追加改修が必要である。これは小さな adapter 追加ではなく探索 engine の段階的 refactor なので、V1 contract の必須条件にしない。まず Web-only capabilities を正直に返す。

## 7. capability の提案

DeepStill adapter が公開する情報は次を含む。

```json
{
  "pluginId": "deepstill",
  "pluginVersion": "0.1.0",
  "engine": { "id": "deepstill-round", "version": "2" },
  "recipeVersion": "deliverables-v1/prompt-5/memory-v1",
  "protocolVersionRange": { "min": "TBD", "max": "TBD" },
  "operations": ["submit", "status", "result", "cancel"],
  "sourceKinds": ["web"],
  "outputKinds": ["report", "claims", "evidence", "knowledge_candidates", "episode_source"],
  "locators": ["web-url+snapshot-sha256+utf8-bytes"],
  "limits": {
    "budget": "derived-from-createJobSchema",
    "resultBytes": "TBD",
    "retentionSeconds": null
  },
  "optionalHostCapabilities": [
    "llm_gateway",
    "knowledge_read",
    "source_connector",
    "usage_audit_sink"
  ]
}
```

`protocolVersionRange`、result byte 上限、retention は合意前に数値を確定しない。未実装 capability は宣言しない。特に external source connector は将来予定であり、現行実装の capability に含めない。

## 8. request mapping

host request から `createJobSchema` へ直接 object spread しない。adapter が検証して内部入力と protocol metadata を分ける。

```ts
interface AdapterSubmitRequest {
  idempotencyKey: string;
  requestHash: string;
  question: string;
  strategy?: "balanced" | "diverse";
  targetBudget?: Partial<Budget>;
  hardSafetyCeiling: Partial<Budget>;
  expectedOutputs: string[];
  parentRef?: { kind: string; id: string };
  repositoryIdentity?: {
    projectRef?: string;
    repoKey?: string;
    repoPath?: string;
  };
  optionalHostCapabilities?: Record<string, unknown>;
}
```

最初の Web-only mapping は次でよい。

- question -> topic
- strategy -> strategy
- adapter の deterministic test -> mode mock
- live plugin request -> mode live
- `min(host hard ceiling, deployment ceiling, schema max)` -> internal budget
- target budget、parent ref、request hash、host capability は integration metadata とし、既存 create input に混ぜない
- ContextStill の DB ID は opaque parent ref であり DeepStill job ID にしない

同じ idempotency key と同じ canonical request hash は同じ DeepStill job ID を返す。同じ key と異なる hash は conflict とする。hash input から transport metadata、送信時刻、未知 optional field をどう扱うかは host contract で固定する必要がある。

## 9. result mapping

adapter は `JobDetail` をそのまま外部へ返さない。内部 config、operation audit、prompt 本文、snapshot 全文、secret を除外し、外部用 bundle を構築する。

```json
{
  "schemaVersion": "host-owned-version-placeholder",
  "requestHash": "sha256:...",
  "resultHash": "sha256:...",
  "execution": {
    "pluginJobId": "...",
    "status": "partial",
    "reason": "unresolved_questions",
    "engineVersion": "2",
    "recipeVersion": "deliverables-v1/prompt-5/memory-v1",
    "usage": {},
    "targetBudgetExceeded": false
  },
  "report": {},
  "claims": [],
  "evidencePackages": [],
  "knowledgeCandidates": [],
  "episodeSource": null,
  "omissions": []
}
```

状態は次のように扱う。

- completed: requested research の必須条件を満たし、利用可能な result がある。
- partial: terminal だが未解決条件または品質不足があり、検証済み result の一部がある。
- failed: terminal で、要求用途に使える検証済み result がない。
- cancelled: cancel が確定した。cancel 前の検証済み partial result の有無は別 field で示す。
- degraded: lifecycle status ではなく、optional capability 不在や一部 source failure の annotation とする。

現行 job の completed / partial を機械的にそのまま外部 status にせず、result availability、artifact quality、dangling reference、locator integrity を確認して投影する。

## 10. access metadata

result bundle に ACL 本文、token、cookie、認証 header を含めない。host が結果の公開範囲を絞るために、次だけを返す。

- connector kind と instance ID
- tenant / workspace / container / channel / space の opaque scope reference
- visibility class。例: public、tenant、container、restricted、unknown
- authorization scope reference または access policy version
- source を取得した principal class。個人 token ID や secret は含めない

DeepStill は host の認可を代行しない。source の visibility が unknown の場合、host は広い scope へ自動公開しない。

## 11. retention と ACK

現行 DeepStill は明示 delete まで DB と artifact を保持する。自動 retention や ACK state はない。したがって capabilities で保持期間を宣言する前に、次を永続化する必要がある。

- idempotency key / request hash / job ID
- result hash / generated at / available until
- ACK した host principal / result hash / acknowledged at
- ACK 後 grace deadline
- purge state と audit event

ACK は import commit 済みの通知であり、即時削除命令ではない。異なる result hash の ACK は拒否する。未 ACK result、active job、resume 可能 job、外部結果不明で blocked の job は自動削除しない。

この機能は DB migration と GC policy を伴うため、interface 抽出と同じ変更に混ぜない。

## 12. 先行実装できる範囲

ContextStill contract 確定前でも、外部挙動を変えずに次を実装できる。

1. `ContextStillMcp` を Knowledge read client として独立 file へ移す。
2. protocol 非依存の `ResourceIdentity`、`FragmentLocator`、`EvidenceLocator` を追加する。
3. Web Snapshot / Evidence から locator への pure mapping を作る。
4. `JobDetail` から外部 result 候補を作る pure mapping を作る。
5. mapping の deterministic fixture と integrity validation を作る。
6. capabilities を pure data として生成し、未実装 capability を含めないテストを作る。
7. standalone provider 構成と API response が変わらない回帰テストを追加する。

## 13. contract 確定まで待つ範囲

- public endpoint path と transport
- protocol version と schema の正本
- request canonicalization と hash 対象 field
- idempotency record の保持期間
- ACK と GC の時間値
- auth principal と secret rotation
- callback か polling か
- host LLM Gateway の wire extension と error taxonomy
- external SourceConnector の invocation protocol
- visibility reference の語彙
- result bundle byte 上限と省略優先順位
- ContextStill Knowledge / Episode への正式 import schema

## 14. 検証計画

### 14.1 deterministic contract mapping

- 同じ key / 同じ request hash が同じ job ref へ解決される。
- 同じ key / 異なる hash を拒否する。
- completed、partial、failed、cancelled の fixture を正しく投影する。
- claim が存在しない evidence、evidence が存在しない claim を拒否する。
- snapshot hash、quote hash、UTF-8 / UTF-16 locator の改ざんを拒否する。
- 日本語、改行、surrogate pair を含む quote で UTF-8 byte range を再計算する。
- 未知 optional field は raw envelope に保持または無視し、必須 field 欠落を拒否する。
- result hash は canonical bundle から安定して生成される。

### 14.2 lifecycle

- worker 再起動後も同じ task を継続し、完了済み paid operation を再送しない。
- submit 応答不明後の再送で二重 job を作らない。
- cancel_requested から新規 operation を開始しない。
- cancel 前に保存された valid partial result を status と分けて返す。
- blocked external result unknown を completed にしない。
- ACK 再送は no-op、異なる hash は conflict にする。
- retention 中は result を取得でき、grace 後だけ purge 対象になる。

### 14.3 standalone 回帰

- integration 無効時の API、worker、CLI、Web UI の response と挙動を維持する。
- provider credential なしで mock / fixture test が通る。
- `ContextStillMcp` 未設定時は disconnected のまま研究を続ける。
- live provider test は通常 gate から分離し、未実行を明記する。

### 14.4 品質 canary

contract test 通過と研究品質改善を分ける。統合後の canary は同一 question、同一 budget、同一 provider 条件で、query、source 選定、独立 evidence、Report、Knowledge、Episode、正常終了、input / output token、待ち時間を比較する。ContextStill 経由になったことや Report の見栄えだけを採用理由にしない。

## 15. 推奨する実装順序

### Phase A: 境界だけを固める

- ContextStill Knowledge client の file 分離
- resource identity / locator 内部型
- result projection と validation
- deterministic fixtures と mapping tests
- standalone regression

DB schema、公開 API、認証は変更しない。

### Phase B: host contract との適合

ContextStill が所有する contract draft を受け取り、DeepStill adapter schema、capabilities、request / result mapping を確定する。双方の fixture を照合する。この時点でも transport は in-process test adapter でよい。

### Phase C: lifecycle transport

認証付き submit / status / result / cancel を追加し、idempotency record を migration で永続化する。ACK と retention は利用側の import transaction が確定してから追加する。

### Phase D: optional host capabilities

Knowledge read scope、usage / audit sink、LLM Gateway を個別に追加する。いずれも capability negotiation で無効化でき、未接続時は standalone provider へ戻る。

### Phase E: external connectors

Web-only adapter の運用実績後に、SourceConnector port を engine の action state と prompt へ浸透させる。最初から Slack、Confluence、SharePoint の共通実装を推測しない。

## 16. 非目標と変更停止条件

今回の準備では次を行わない。

- ContextStill repository の変更
- ContextStill 専用 endpoint の実装
- 汎用 protocol version の確定
- DB migration、retention GC、認証変更
- SharePoint、Confluence、Slack connector 実装
- Knowledge / Episode の自動登録
- LLM Gateway 実装

既存 DB schema、公開 API、認証方式の変更が必要になった時点で、migration、compatibility、rollback、standalone 回帰を別設計として先に提示する。

## 17. 実装開始時点の状態

Phase A の最初の変更として、次を実装した。

- ContextStill Knowledge contract と MCP client の file 分離
- repository identity 付き `search_knowledge` 呼び出し
- ContextStill 管理 SQLite を MCP 経由で使うための環境設定
- connector 非依存の resource identity / fragment locator
- SourceConnector port
- `JobDetail` から protocol 非依存 result projection への変換
- snapshot、quote、dangling claim / evidence reference の deterministic test

ContextStill SQLite を DeepStill process から直接開く処理は追加していない。ContextStill の resident writer、repository isolation、schema ownership を維持するため、読み取りは既存 MCP endpoint を経由する。

公開 plugin endpoint、submit idempotency の永続化、ACK、retention、認証、host protocol schema は未実装である。次に ContextStill 側へ protocol ownership、Web-only locator、LLM Gateway の順序、budget semantics の4点を返し、双方の境界認識を合わせる。合意前に進める変更は pure mapping、fixture、standalone 回帰に限定する。
