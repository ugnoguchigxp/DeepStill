# DeepStill コンセプト

初期構想を保存した文書。実装範囲・段階・完了条件は[実装計画](plan.md)を正本とする。依存評価による具体化は[依存パッケージ評価](dependency-evaluation.md)を参照。

### 1. Project Overview

**DeepStill** は、時間をかけてWebを探索し、根拠付きの長文Research Artifactを生成する **Evidence-first Research Engine** である。

一般的な検索エンジンやDeep Researchのように、その場で即答することを目的としない。

DeepStillでは、1つのResearch Topicについて、

* 検索キーワードを展開する
* 関連する検索結果を探索する
* Webページや一次情報をクロールする
* Evidenceを収集する
* Claimを抽出する
* 既知情報との重複を除外する
* 調査範囲を段階的に拡張する
* 十分なEvidenceが集まった時点でResearch Artifactを生成する

という処理を、比較的長時間かけて実行する。

最終成果物は単なるLLM生成文章ではなく、**すべての重要な記述から原典まで遡れるResearch Artifact** とする。

---

## 2. Core Concept

DeepStillの基本思想は以下。

> Compile once, read many.

毎回ゼロからWeb検索して回答するのではなく、一度時間をかけて調査した内容を静的なResearch Artifactとして生成し、再利用する。

イメージ:

```text
Research Topic
      ↓
Knowledge Check
      ↓
Query Frontier
      ↓
Search
      ↓
Crawler
      ↓
Evidence
      ↓
Claims
      ↓
Finding
      ↓
Research Artifact
      ↓
Knowledge Candidate
```

DeepStillは検索エンジンというより、

**Research Compiler**

あるいは

**Knowledge Expansion Engine**

として考える。

---

## 3. Relationship with ContextStill

DeepStillは最初からContextStill本体へ組み込まない。

**独立プロジェクトとして実装し、Plugin / IntegrationとしてContextStillと接続する。**

目的は、十分な動作検証を行ったあとで正式統合するか判断できる状態にすること。

```text
ContextStill
     │
     │ API / RPC
     ▼
DeepStill
     │
     ▼
External Web
```

DeepStillとContextStillでDBを共有してはいけない。

ContextStillの内部DB構造にDeepStillを依存させない。

---

## 4. Responsibility Boundary

### ContextStill

ContextStillは、

**何を調査する価値があるか**

を判断する。

主な情報源:

* Knowledge
* Episode
* Vibe Memory
* Finding
* Knowledge Landscape
* Knowledge freshness
* Knowledge confidence
* Knowledge coverage

例えば、

```text
Knowledgeが存在しない
→ Research Candidate

KnowledgeはあるがCoverageが低い
→ Research Candidate

古い
→ Refresh Candidate

Evidenceが弱い
→ Verification Candidate

十分なKnowledgeがある
→ Skip
```

と判断する。

---

### DeepStill

DeepStillは、

**指定されたテーマを外部世界から調べる**

ことだけに集中する。

責務:

```text
Query Expansion
Search
Crawl
Evidence Collection
Claim Extraction
Deduplication
Research Governance
Research Artifact Generation
```

DeepStill自身がContextStillのKnowledge管理責務を持たない。

---

## 5. Input Sources

DeepStill単体でも使用可能にする。

### Manual Research

```text
User
 ↓
Research Topic
 ↓
DeepStill
```

例:

```text
"Local LLM KV Cache Routing"
```

---

### ContextStill Integration

ContextStillから以下をResearch Seedとして受け取れるようにする。

```ts
type ResearchSeed = {
  text: string;

  source:
    | "manual"
    | "knowledge"
    | "finding"
    | "vibe"
    | "episode";

  relatedKnowledgeIds?: string[];

  priority?: number;
};
```

特にVibe Memoryは重要な入力。

Vibe Memoryは検索Queryとして直接使用するのではなく、

```text
Vibe Memory
    ↓
Finding / Concept extraction
    ↓
Research Seed
```

と変換する。

---

## 6. Query Frontier

DeepStillのResearch Engineの中心。

検索Queryを単純なTreeではなく、Graphとして保持する。

```text
Topic
 │
 ├─ Google Autocomplete
 │
 ├─ Related Searches
 │
 ├─ People Also Ask
 │
 ├─ Content-derived Concepts
 │
 └─ LLM Query Expansion
```

例:

```text
local LLM harness
       │
       ├── model routing
       │      └── KV cache routing
       │               └── cache locality
       │
       ├── multiple model serving
       │
       └── inference orchestration
```

Query同士の関係を保存する。

---

## 7. Search Provider

Search Providerは必ず抽象化する。

```ts
interface SearchProvider {
  suggest(
    query: string
  ): Promise<QuerySuggestion[]>;

  search(
    query: string
  ): Promise<SearchResult[]>;
}
```

初期候補:

```text
DataForSEO
```

用途:

* Google Autocomplete
* Google Organic Search
* Related Searches
* People Also Ask

理由:

DeepStillはリアルタイムレスポンスが不要なので、安価なQueue型APIとの相性が非常に良い。

将来的に、

```text
Brave
SearXNG
その他Provider
```

を差し替え可能にする。

Search ProviderをCoreロジックへ直接埋め込まない。

---

## 8. Research Frontier Control

検索キーワードを再帰的に広げると指数的に増加する。

例:

```text
1
→ 10
→ 100
→ 1,000
→ 10,000
```

そのためDeepStillでは、

**Best-first Search**

を基本とする。

候補Queryすべてを探索してはいけない。

各QueryへScoreを付ける。

例:

```text
FrontierScore =
    KnowledgeGap
  + Novelty
  + UserInterest
  + EvidenceNeed
  + QueryDiversity
```

Score上位のみ次のResearch Roundへ進める。

---

## 9. ContextStill Knowledge Check

LLMを使う前にContextStillを確認する。

```text
Query Candidate
      ↓
ContextStill Search
      ↓
Known?
```

例:

```text
similarity = 0.96
→ Skip

similarity = 0.70
→ Verify / Extend

similarity = 0.40
→ Explore
```

目的:

* Duplicate Knowledgeを作らない
* LLM Tokenを節約する
* Search Queryを減らす
* Knowledge Gapへ集中する

---

## 10. Research Governor

DeepStillでは、

**探索を広げる能力より、探索を止める能力を重視する。**

無限Researchは禁止。

Research Governorを独立コンポーネントとして持つ。

```text
Research Governor
 ├─ Query Budget
 ├─ URL Budget
 ├─ Token Budget
 ├─ Time Budget
 ├─ Depth Limit
 ├─ Saturation Detection
 └─ Marginal Knowledge Gain
```

---

## 11. Marginal Knowledge Gain

Research継続判断の主要指標。

```text
Knowledge Gain / Research Cost
```

例:

```text
Round 1
20 Queries
→ 15 useful findings

Round 2
20 Queries
→ 8 findings

Round 3
20 Queries
→ 2 findings

Round 4
20 Queries
→ 0 findings
```

Round 3付近でResearchを終了する。

指標:

```text
ΔKnowledge / ΔCost
```

が閾値以下になった場合に停止。

---

## 12. Hard Limits

Saturation Detectionだけに依存しない。

必ずHard Limitを持つ。

PoC例:

```text
Queries       <= 50
Fetched URLs  <= 100
LLM Documents <= 20
LLM Tokens    <= 100k
Depth         <= 5
Wall Time     <= 2h
```

値はConfigurableにする。

---

## 13. LLM Usage Policy

DeepStillではLLMを探索の中心にしない。

可能な限りLLMを使う前に候補を絞る。

```text
1000 Query Suggestions

↓ normalize

350 unique

↓ ContextStill lookup

170 unknown

↓ SERP relevance

60 candidates

↓ crawl ranking

20 pages

↓ LLM

8 meaningful findings
```

大量のCandidateをLLMへ直接投入しない。

---

## 14. Processing Levels

処理コストを段階化する。

```text
Level 0
No LLM
----------------
Exact Match
FTS
Embedding
Deduplication

Level 1
Very Cheap
----------------
Autocomplete
SERP
URL Ranking
Domain Filtering

Level 2
Cheap LLM
----------------
Snippet relevance
Concept extraction
Query evaluation

Level 3
Normal LLM
----------------
Relevant section analysis
Claim extraction
Evidence extraction

Level 4
Expensive
----------------
Cross-source synthesis
Contradiction analysis
Research Artifact generation
```

大部分の候補をLevel 0〜1で終了させる。

---

## 15. Crawler

Crawlerは段階的に処理する。

```text
HTTP Fetch
   ↓
HTML
   ↓
Readability
```

これで取得できるページはBrowser Rendererを使用しない。

動的ページのみ、

```text
Browser Renderer
```

へFallbackする。

Crawler Interface:

```ts
interface Crawler {
  crawl(url: string): Promise<CrawledDocument>;
}
```

Browser Engineも抽象化する。

```ts
interface BrowserEngine {
  render(url: string): Promise<RenderedPage>;
}
```

候補:

```text
Bun.WebView
Playwright
```

Bun.WebViewはExperimentalなので、実装を固定しない。

---

## 16. Partial Document Reading

Webページ全文をLLMへ渡さない。

```text
HTML
 ↓
Boilerplate removal
 ↓
Heading segmentation
 ↓
Keyword / Embedding retrieval
 ↓
Relevant sections
 ↓
LLM
```

例えば:

```text
30,000 tokens
↓
2,500 tokens
```

程度まで減らしてから解析する。

---

## 17. Evidence-first Architecture

DeepStillの最重要要件。

Research Artifact内の重要な記述は必ず、

```text
Artifact
 ↓
Claim
 ↓
Evidence
 ↓
Source
```

まで追跡可能にする。

EvidenceのSourceとして利用できるのは原則として外部情報。

例:

```text
web
paper
official documentation
github
primary source
```

ContextStill内部の、

```text
Knowledge
Episode
Vibe Memory
```

をEvidenceとして扱わない。

これらは、

```text
Seed
Context
Hypothesis
Query Generator
```

としてのみ使用する。

内部生成情報を再Evidence化して自己強化することを防ぐ。

---

## 18. Core Entities

最低限以下を持つ。

### ResearchJob

Research全体。

```text
topic
status
budget
createdAt
startedAt
completedAt
metrics
```

---

### QueryNode

探索Query。

```text
query
depth
priority
score
status
```

---

### QueryEdge

Query同士の関係。

```text
from
to

source:
  autocomplete
  related_search
  people_also_ask
  llm
  content
```

---

### Source

取得元。

```text
url
title
author
publishedAt
crawledAt
contentHash
sourceType
```

---

### Evidence

Source内の根拠。

```text
sourceId
text
location
context
```

---

### Claim

Evidenceから確認できる主張。

```text
text
confidence
```

Relationship:

```text
Claim
 ├─ SUPPORTS → Evidence
 └─ CONTRADICTS → Evidence
```

---

### Finding

Research中に得られた知見。

```text
NEW
KNOWN
DUPLICATE
CONTRADICTION
WEAK_EVIDENCE
```

---

### ResearchArtifact

人間向けResearch Report。

```text
title
body
version
generatedAt
```

Artifact内のClaimからEvidenceへ参照可能にする。

---

## 19. Knowledge / Episode Output

DeepStillはContextStillへ直接Knowledgeを登録しない。

返すのは、

```text
KnowledgeCandidate
EpisodeCandidate
```

まで。

最終採用判断はContextStill。

---

### Knowledge Candidate

再利用可能な知識。

例:

```text
Mooncake supports disaggregated
prefill/decode architecture...
```

---

### Episode Candidate

Researchを通して得られた経験・経緯。

例:

```text
LARMのKV Cache routing改善を調査。

Mooncake / SGLang / vLLMを比較した結果、
cache localityをrouting判断に使用する価値が
あることが判明した。
```

原則:

```text
Knowledge = What we learned

Episode = Why / How / When we learned it
```

---

## 20. Recommended Technology Stack

初期PoCではTypeScript中心。

```text
Runtime
  Bun

Backend
  Hono

Frontend
  React
  TypeScript
  Vite

UI
  Tailwind CSS v4
  shadcn/ui

Data Fetching
  TanStack Query

Validation
  Zod

Database
  SQLite
  Drizzle ORM

Streaming
  SSE

Static Crawl
  fetch
  Mozilla Readability

Dynamic Crawl
  BrowserEngine abstraction
  Bun.WebView / Playwright

LLM
  Provider Adapter
  LARM compatible

Search
  SearchProvider abstraction
  DataForSEO first

ContextStill
  ContextStill Adapter
```

RedisやPostgresは初期段階では導入しない。

---

## 21. Process Architecture

Web APIとResearch Workerは分離する。

```text
Browser
   │
   ▼
React UI
   │
 HTTP / SSE
   ▼
Hono API
   │
 SQLite
   │
   ▼
Research Worker
```

実行例:

```bash
bun run api
bun run worker
bun run web
```

同一Repositoryで構わないが、Workerは別Process。

理由:

* Crawler crash隔離
* Research処理とUIの分離
* 将来的な別Machine Worker対応
* Scale out可能

---

## 22. Repository Structure

```text
deepstill/
│
├─ apps/
│  ├─ web/
│  ├─ api/
│  └─ worker/
│
├─ packages/
│  ├─ core/
│  │   ├─ research-job/
│  │   ├─ frontier/
│  │   ├─ finding/
│  │   ├─ evidence/
│  │   └─ governor/
│  │
│  ├─ crawler/
│  ├─ search-provider/
│  ├─ llm-provider/
│  ├─ db/
│  │
│  └─ integrations/
│      └─ contextstill/
│
└─ data/
   └─ deepstill.sqlite
```

Coreは可能な限りI/O非依存にする。

Ports & Adaptersを使用する。

---

## 23. Web UI

Web UIはReport Viewerではなく、

**Research Debugger**

として設計する。

最低限必要な画面:

### Research Dashboard

表示:

```text
Research Topic
Status
Elapsed Time
Queries
URLs
Tokens
Findings
Knowledge Candidates
```

---

### Frontier Viewer

Research Graphを表示。

```text
Topic
 ├── Query A
 ├── Query B
 │    └── Query C
 └── Query D
```

各Queryについて、

```text
score
source
depth
status
reason
```

を確認可能にする。

---

### Findings Viewer

```text
NEW
KNOWN
DUPLICATE
CONTRADICTION
REJECTED
```

で分類。

---

### Artifact Viewer

Research Report本文を表示。

Citationをクリック可能にする。

---

### Evidence Viewer

Citationから、

```text
Artifact Sentence
      ↓
Claim
      ↓
Evidence
      ↓
Source
```

を確認できる。

表示項目:

```text
Title
URL
Author
Published
Crawled At
Relevant Passage
Context
Original Source
```

---

## 24. SQLite Queue

初期段階でRedisは使用しない。

例:

```text
research_tasks

id
job_id
type
status
priority
lease_until
attempts
payload
created_at
```

WorkerはLease方式で取得。

CrashしたTaskはLease expiration後に再取得可能にする。

---

## 25. Observability

DeepStillではResearch品質の評価が非常に重要。

必ずMetricsを保存する。

主なMetrics:

```text
Novel Finding Rate
Knowledge Adoption Rate
Duplicate Rate
Search Efficiency
Token Efficiency
Research Saturation
Average Finding Score
```

定義例:

```text
Novel Finding Rate
=
New Findings / All Findings
```

```text
Knowledge Adoption Rate
=
Accepted Knowledge / Knowledge Candidates
```

```text
Token Efficiency
=
Accepted Knowledge / 100k LLM Tokens
```

---

## 26. Strategy Experimentation

PoCでは探索Strategyを交換可能にする。

例:

```text
Strategy A
Autocomplete only

Strategy B
Autocomplete + Related Searches

Strategy C
LLM Query Expansion

Strategy D
Search Suggestions + LLM

Strategy E
ContextStill Gap-driven
```

インターフェース例:

```ts
interface FrontierStrategy {
  expand(
    context: FrontierContext
  ): Promise<QueryCandidate[]>;
}
```

同一Topicに対してStrategyを比較可能にする。

比較項目:

```text
Queries
Search Requests
URLs
LLM Tokens
Novel Findings
Knowledge Adoption
Execution Time
```

---

## 27. Initial PoC Scope

v0.1では機能を増やしすぎない。

実装対象:

```text
Topic Input
     ↓
ContextStill Knowledge Check
     ↓
Autocomplete
     ↓
Query Frontier
     ↓
Top Query Search
     ↓
URL Crawl
     ↓
Evidence Extraction
     ↓
Finding
     ↓
Reference付きArtifact
     ↓
Knowledge Candidate
```

ContextStillが未接続でもMock Knowledge Providerで動作可能にする。

---

## 28. v0.1 Non-goals

以下は初期実装から除外する。

```text
完全自律Knowledge Landscape探索
Vibe Memory自動監視
定期再調査
Staleness scheduler
大規模distributed worker
Redis
Postgres
Multi-node crawler
Tauri desktop packaging
高度なKnowledge Graph UI
```

必要になってから追加する。

---

## 29. Desktop Application

初期はBrowserベース。

```text
localhost
+
React Web UI
```

で十分。

TauriはPoC成功後。

React/Vite UIはそのまま再利用できる構成にする。

---

## 30. Success Criteria

DeepStillの価値は、

「たくさん検索した」

では測らない。

重要なのは、

> 限られた計算量で、既存Knowledgeに存在しない有益なKnowledgeをどれだけ発見できたか。

PoC評価例:

```text
100+ Research Jobs

Novel Finding Rate > 30%

Knowledge Adoption Rate > 15%

Duplicate Rate < 40%

無限探索ゼロ

すべての採用Knowledgeに
External Evidenceが存在

ArtifactからSourceまで
完全に追跡可能
```

---

## 31. Fundamental Design Principles

実装では以下を優先する。

#### Evidence First

LLMの生成文章よりEvidenceを優先する。

#### Search Before LLM

LLMに考えさせる前に検索・FTS・Embeddingで絞る。

#### Unknown First

既に知っていることを再調査しない。

#### Best-first Exploration

すべてのQueryを探索しない。

#### Marginal Knowledge Gain

探索継続は情報増分で判断する。

#### Hard Budget

必ずToken / Query / URL / Time上限を設定する。

#### ContextStill Independence

ContextStillなしでもDeepStill単体で動く。

#### No Shared Database

ContextStill DBを直接参照しない。

#### Plugin First

十分な実験と評価を行ってから正式統合を判断する。

---

## 32. Project Definition

DeepStillを一文で定義すると、

> **DeepStill is a slow, evidence-first research engine that explores the web, discovers unknown information efficiently, and compiles every important claim into a traceable research artifact backed by original sources.**

ContextStillとの組み合わせでは、

> **ContextStill decides what is worth knowing. DeepStill goes outside and investigates it.**

という役割分担を目指す。

最終的な目的は、無限にWebをクロールすることではない。

**限られた検索回数・LLM Token・計算時間を、最も価値のあるKnowledge Gapへ配分し、ContextStillのKnowledge Landscapeを効率よく拡張すること。**
