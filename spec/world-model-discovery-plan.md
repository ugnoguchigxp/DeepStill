# ワールドモデル発見タブ 実装計画

作成日: 2026-09-20

状態: V0（WM-01〜07）を実装済み。Phase 5（既存調査の手動再生成）と外部登録は対象外。実装・回帰確認済み、実調査品質は未確認。

実装担当は12〜20節を作業仕様として使用する。1〜11節は背景・設計意図であり、判断が重なる場合は12節以降を優先する。

## 1. 目的と方針

テーマのリサーチから、再利用できる知識に加えて、物事の関係・成立条件・未解決点を見つける。その検討結果を「ワールドモデル発見」タブで確認できるようにする。

リサーチターゲットを「知識／ワールドモデル」の二択にはしない。同じ本文と根拠から、Knowledgeと関係候補の双方を生成する。探索方針は保存先ではなく、調査目的と未解決の問いによって変える。

DeepStillは関係候補と評価の根拠を作る。ユーザー中心の重要性判断、既存World Modelとの統合、正式な関係の採用はSAAA側の責務とする。候補数やグラフの充実度を調査の成功条件にしない。

## 2. 確認した現状

| 箇所 | 現在の役割 | 変更の方向 |
| --- | --- | --- |
| `apps/web/src/main.tsx` | 調査詳細のレポート、Knowledge・Episode、実行履歴等のタブ | 発見タブを追加 |
| `apps/web/src/deliverable-memory.tsx` | Knowledgeの条件・未確認事項・根拠の表示 | 表示パターンを参考にする。Knowledgeを関係へ自動変換しない |
| `packages/research/deliverables.ts` | Draft、部分更新、引用からArtifact・Claim・Evidenceへの変換 | 候補スキーマ、保持・更新規則、根拠検証を追加 |
| `packages/research/deliverable-prompts.ts` | 本文読解・成果物更新・次の探索行動の指示 | 発見と検証の観点を組み込む |
| `apps/worker/deliverable-engine.ts` | 探索ループ、部分更新、予算・読了範囲の検証 | 候補と問いを読解・探索間で引き継ぐ |
| `packages/llm-provider/codex.ts` | 構造化出力用スキーマ | optional項目を含む互換性を確認 |
| `packages/contracts/index.ts` | Artifact、JobDetail等の契約 | 発見結果の後方互換な追加 |
| `packages/db/index.ts` | 保存レコードの読出し、Artifactの版管理 | 保存・再開・旧データ互換を検証 |

現行Draftはsections、knowledge、limitations、openQuestionsを持つ。関係候補を構造化して生成・表示する専用プロセスは確認できない。引用の原文一致・読了範囲の検証は存在するが、それだけでは因果関係の妥当性は保証しない。

## 3. V0の範囲

- 既存の調査詳細に「ワールドモデル発見」タブを追加する。
- 新規のdeliverables-v1調査で、本文読解時に関係候補と調査課題を生成・更新する。
- 根拠、条件、反する情報、別の説明、残った問いを表示する。
- 候補は成果物の版に紐づけて保存し、再起動・再開後も保持する。
- 未生成、生成済み候補なし、候補ありを区別する。
- 旧調査にもタブを表示するが、保存されていない結果を生成済みと見せない。

次はV0の対象外とする。

- SAAA／contextStillへの自動登録、正式なWorld Modelの管理。
- グラフDB、全体グラフUI、因果効果の数値推定、長い因果経路の自動確定。
- 候補の存在だけを理由とする無制限の追加調査。
- 過去の調査の一括再処理、既存legacy探索エンジンへの発見生成の移植。

既存調査からの手動再生成は後続段階に分ける。V0だけで過去の結果に候補が追加されるとは説明しない。

## 4. 画面設計

タブ順は原則「レポート → Knowledge・Episode → ワールドモデル発見 → 実行履歴」とする。legacy画面の既存タブも維持する。

タブの冒頭では「調査資料から見つかった関係の候補です。ワールドモデルへの登録はまだ行われていません」と説明する。

### 4.1 関係候補カード

各カードには次を表示する。

- 主体・対象・関係。例「技術X → 応答待ち時間を減らす」。
- 関係の種類: 影響・因果、相関、依存、目標との関係。
- 評価: 仮説、支持する根拠あり、証拠が競合、判断不能、反証あり。
- なぜその関係を考えたか、資料が実際に示している範囲。
- 成立条件、適用できない条件、時間・対象範囲。
- 支持・反証・背景に分けた根拠と原典リンク・引用。
- 別の原因や説明、未解決の問い。

「支持する根拠あり」は因果の確定や独立レビューの通過を意味しない。引用一致の検証と内容評価を混同しない表示にする。数値のconfidenceはV0で表示せず、評価理由を示す。

### 4.2 未解決の問い

関係カードとは別に、次に調べる問いを表示する。関係候補をまだ作れない知識不足もここへ置く。

例: 因果方向不明、仕組み不明、成立条件不足、根拠の競合、個別環境への適用不明。

### 4.3 空状態と更新

- 未生成: 「この調査では、ワールドモデル向けの発見処理はまだ行われていません」。
- 生成済み候補なし: 「読解した資料から、根拠を付けて提示できる関係候補は見つかりませんでした」。
- 実行途中: 現時点の候補と成果物の版を示す。完了結果と誤認させない。
- エラー・予算不足: 既存の部分成果を保持し、今回の更新ができなかったことを表示する。

候補がないことを、現実に関係が存在しない証拠として扱わない。タブの切り替えだけではLLM呼出しや再調査を開始しない。

## 5. 発見プロセス

1. 通常どおりテーマと調査目的から検索・本文読解を行う。
2. 本文読解時に、説明・Knowledgeと合わせて関係候補を検討する。
3. 資料の明示的な主張と、LLMが組み立てた仮説を分ける。
4. 候補に根拠・条件・反する情報・不明点を付ける。
5. スキーマと引用・読了範囲を検証し、成功した成果物を保存する。
6. 次の探索では、元の依頼に関係する未解決点を考慮する。
7. 終了時に候補と未解決点を残す。因果関係が確定しなくても調査結果を保存できる。

V0は既存の本文読解呼出しへ統合し、毎回別の因果レビューLLMを追加する方式は採らない。出力増加に伴うtoken・予約枠・読解量への影響は比較評価する。

候補の発見が元の問いを脱線させないよう、問いには「元の依頼への回答に必要／任意の追加調査」を区別する。任意のResearchGapが残っているだけでfinishを妨げない。探索用入力には候補の全文ではなく、必要な関係・条件・問いの要約を渡す。

## 6. 関係と根拠の扱い

- 相関を因果へ自動昇格しない。
- 著者が因果を主張していることと、研究が因果を支持できることを分ける。
- 実験・観測・理論的説明・著者の主張等、根拠の性質を記録する。記載がなければ不明とする。
- 効果の比較対象、対象集団・環境、測定指標を分かる範囲で残す。
- 支持記事の件数を独立した証拠の件数とみなさない。
- 条件や機序の不足をLLMの推測で埋めない。
- A→B、B→CからA→Cの直接関係を生成しない。複合的な推論は仮説と明示する。
- 「遅延」と「遅延の低下」のように、変数と変化を混ぜない。
- 主体の目標は、資料や本人の明示と推測を区別する。
- 一般的な関係からユーザー個人への適用を確定しない。

## 7. データと保存

以下は内部モデルの計画であり、SAAAとの連携契約の確定ではない。

### 7.1 発見結果

ArtifactにoptionalなworldModelDiscoveryを追加する。欠落は未生成、存在してcandidatesが空なら生成済み候補なしとする。生成対象の成果物版、スキーマ版、候補、未解決点を保持する。

候補の主な項目は次とする。

| 項目 | 意味 |
| --- | --- |
| id | 更新時に候補を追跡する識別子 |
| subject / relation / object | 関係の両端と意味 |
| assessment | 仮説・支持・競合・判断不能・反証 |
| basis | 資料の明示的記述か、根拠からの推論か |
| explanation | 評価理由 |
| conditions / exceptions / scope | 成立条件・例外・対象と時間 |
| evidence | 支持・反証・背景の区別と根拠参照 |
| alternatives | 別の説明 |
| researchGaps | 未解決点への参照 |

LLM生成段階では既存と同様のsourceIdと行範囲で根拠を指定し、materializeで原文に結び付ける。候補の引用も実際に読んだ範囲内に限定する。独立した検証済み事実と誤解されないよう、仮説の候補を通常のaccepted Claimへ無条件に混入させない。候補用の根拠参照は役割を保持して保存する。

### 7.2 更新と互換性

- 候補の更新省略は保持、明示的な空配列は候補なしへの更新として区別する。
- 全文更新とsectionUpdateの双方で、既存候補が意図せず消えない契約を定める。
- 検索後のnavigation-only応答で候補を書き換えない。
- 修正・削除には理由を残す。候補の両端だけで異なる条件・対象範囲を統合しない。
- 古い成果物は不変とし、最新の対応版のみ表示する。
- レポート改稿後は旧版に候補を残し、タブで参照元の版と未再評価を明示する。最新版へコピーしない（16節）。
- 旧DB・旧fixtureはフィールド欠落を許容する。

現行の汎用レコード保存を利用し、専用テーブル・DB migrationは追加しない。保存・再読込をテストする。JobDetailの追加フィールドはAPI契約の変更なので、型・projection・エクスポートにも影響を調査する。外部連携への公開は別途契約化する。

## 8. 既存調査の再生成を追加する場合

V0後の段階として、「保存済み資料から発見する」を用意する。タブを開くだけでは実行しない。

実行時は既存のworker、operation ledger、予算予約、キャンセル、版管理を使う。ブラウザーからLLMを直接呼ばない。保存本文を今回実際に入力・読解した範囲を記録し、既存の読解範囲との整合を取る。追加Web検索はこの操作に含めない。

資料不足の場合は未解決点を返す。二重クリック、再起動、失敗時の再実行で重複課金や既存成果物の消失が起きない設計を先に確定する。endpointと実行種別はこの段階で設計し、既存の改稿処理へ無理に相乗りさせない。

## 9. 実装順序

### Phase 1: 契約と保存

候補・根拠・ResearchGapのスキーマと状態を定義する。旧データ互換、更新省略と明示的削除、版管理、引用の保存・参照を先にテストする。

### Phase 2: 読解と探索への統合

全文更新・部分更新双方へ発見プロセスを組み込む。navigation入力に必要な問いを引き継ぎ、元の依頼との関連性と予算に基づいて次の資料を選ぶ。生成スキーマ、プロンプト、worker入力を揃える。

### Phase 3: タブ表示

専用コンポーネントで関係候補、条件、根拠、未解決点、空状態を表示する。既存のカード表現に合わせ、モバイル幅・長い日本語・多数の根拠を確認する。

### Phase 4: 回帰と調査品質の比較

fixture、worker統合、UI、既存調査の回帰を実行する。同一テーマ・資料・予算で変更前後を比べ、候補の妥当性に加えてレポート品質・token・読解資料数・早期終了を確認する。

### Phase 5: 既存調査への手動再生成

V0の品質を確認後、前節の実行契約を具体化して別変更として追加する。

## 10. 検証と受入条件

### データ・実行

- 旧成果物を読み込め、未生成と候補なしを区別できる。
- 存在しないsource、改ざんした本文、未読範囲の引用を拒否する。
- 部分更新・navigation・再開で候補が消失しない。
- 不正出力や予算不足で最後の有効な成果物を保持する。
- 任意のResearchGapだけを理由に調査を無限継続しない。
- 候補用根拠が通常の検証済み知見数を不当に増やさない。

### 内容

- 相関だけの資料からは因果確定を出さない。
- 条件付きの効果から条件を落とさない。
- 反証・競合を支持情報と区別して提示できる。
- 機序が不明なら不明のまま残せる。
- 多段の推論を直接の観測や証拠として扱わない。
- 根拠のある依存・目標関係も扱える。
- 候補を生成できない資料から無理に候補を増やさない。

### UI・回帰

- 両方のタブ構成から発見タブを開ける。
- タブを開いても新たな調査や課金処理を開始しない。
- 評価・条件・根拠・未解決点が読み取れ、原典へ遡れる。
- 調査を切り替えた際に別調査の候補が残らない。
- 型・lint・format・関連テスト・build・文書検査を通す。実装変更に対応するE2Eも実行する。
- live調査の品質評価はfixture成功と区別し、未実行なら明記する。

## 11. 代替案と判断

| 案 | 利点 | 問題 | 判断 |
| --- | --- | --- | --- |
| タブだけ追加し既存Knowledgeを表示 | 変更が小さい | 発見プロセスがなく、因果と知識を混同する | 採らない |
| 最後にレポートだけから関係を抽出 | 探索への影響が小さい | 原典の条件・反証を取り逃し、途中の探索にも使えない | 補助用途に限定 |
| 毎回独立した発見LLMを呼ぶ | 調査本文の生成と分離しやすい | 呼出し・文脈・予算が増える | V0では採らない |
| 読解時に発見し、共通根拠から保存 | 条件や不明点を探索中に利用できる | 出力増加と既存品質への影響がある | V0の第一案。比較評価が必要 |

実装開始時にはPhase 1〜4をV0として扱い、Phase 5や外部登録を自動的に含めない。

## 12. 実装者向け確定仕様

以下をPhase 1〜4の実装仕様とする。前節までの「第一案」「確認して決める」より本節以降を優先する。Terraを含む実装担当は、この文書だけでV0を実装し、Phase 5を着手範囲へ含めない。今回の依頼は計画の具体化までであり、現時点ではコード変更を行わない。

### 12.1 先に固定する判断

| 論点 | V0での決定 |
| --- | --- |
| 保存先 | 既存Artifactのoptionalフィールド。専用テーブル・migrationを追加しない |
| 実行タイミング | 新規deliverables-v1の既存本文読解呼出しへ統合。専用LLM呼出しなし |
| 有効化 | 作成時にJob.config.worldModelDiscoveryVersion = 1を保存。既存Jobの欠落は無効 |
| 旧Job再開 | 発見処理を後付けしない。旧プロンプト・旧出力契約を維持 |
| 関係の採用 | DeepStill内の候補保存のみ。World Modelへの登録操作なし |
| 根拠保存 | 共通Evidenceを利用。候補のためにClaimは作らない |
| 候補更新 | 配列全体の置換。nullまたは省略は保持。変更理由を必須にする |
| 候補ID | 意味の同一性から決定的に生成。LLMに永続IDを作らせない |
| API | 既存GET /api/jobs/:id内のArtifactに追加。新規endpointなし |
| 外部連携 | ResearchEngineの公開projectionとcapabilitiesは増やさない |
| 改稿後 | 過去の候補を最新版へコピーしない。タブで参照元の旧版を明示 |
| UI操作 | 読み取り専用。生成・採用・登録・削除ボタンなし |
| エラー | 既存の成果物修正・部分終了ルールへ合流。独立したretryループなし |
| 状態の正本 | Job、Flow、Artifact、既存event。localStorageや別進捗ストアなし |

### 12.2 新設ファイルと依存方向

| ファイル | export／責務 |
| --- | --- |
| `packages/research/world-model-schema.ts` | Zodスキーマ、列挙値、保存型。Node専用APIをimportしない |
| `packages/research/world-model-discovery.ts` | mergeDiscovery、materializeDiscovery、discoveryNavigationContext |
| `packages/research/world-model-view.ts` | selectDiscoveryArtifact。ブラウザーからimport可能な純粋関数 |
| `packages/research/source-citations.ts` | 既存引用処理から抽出するcitationSchema、sourceLines、resolveCitations |
| `apps/web/src/world-model-discovery.tsx` | WorldModelDiscoveryコンポーネント |
| `tests/world-model-discovery.test.ts` | スキーマ、merge、根拠、ID、版選択の単体テスト |
| `tests/world-model-discovery-ui.test.tsx` | 表示・空状態・版・根拠のUIテスト |
| `tests/world-model-discovery-engine.test.ts` | fixture providerを使うworker統合テスト |
| `tests/e2e/world-model-discovery.spec.ts` | タブ操作とレスポンシブの回帰 |

UIからNode専用コードを読まないため、selectDiscoveryArtifactはNode依存のない別ファイル `packages/research/world-model-view.ts` に置く。上表のdiscoveryモジュールからも必要ならre-exportする。contractsはschemaからのtype importのみとする。schema→contracts→schemaの実行時循環を作らない。

source-citationsへの切り出しは既存アルゴリズムを変えない。deliverables.tsから既存のcitationSchema、sourceLinesをre-exportし、既存importを一斉変更しない。文字列quote形式の旧引用互換も維持する。

## 13. 型・スキーマの詳細

### 13.1 列挙値

```ts
type DiscoveryRelation =
  | "causes" | "increases" | "decreases" | "enables" | "inhibits"
  | "correlates_with" | "depends_on" | "has_goal" | "serves_goal";
type DiscoveryAssessment =
  | "hypothesis" | "supported" | "disputed" | "insufficient_evidence" | "refuted";
type DiscoveryBasis = "source_statement" | "inference";
type DiscoveryGapKind =
  | "missing_knowledge" | "unknown_causal_direction" | "missing_mechanism"
  | "missing_condition" | "conflicting_evidence" | "unknown_applicability";
type DiscoveryEvidenceRole = "supports" | "contradicts" | "background";
type DiscoveryEvidenceMethod =
  | "experiment" | "observation" | "theory" | "author_statement" | "unknown";
```

`causes`の候補は因果の証明を意味しない。relationとassessmentを必ず組み合わせて表示する。`supported`は「資料がその関係を支持しているというLLMの評価」であり、決定的に検証できた事実とは区別する。

### 13.2 LLMから受ける型

```ts
interface DiscoveryGapInput {
  kind: DiscoveryGapKind;
  question: string;
  relevance: "required" | "optional";
  reason: string;
}
interface DiscoveryCandidateInput {
  subject: string;
  relation: DiscoveryRelation;
  object: string;
  correlationDirection: "positive" | "negative" | "unknown" | null;
  assessment: DiscoveryAssessment;
  basis: DiscoveryBasis;
  explanation: string;
  conditions: string[];
  exceptions: string[];
  scope: string | null;
  alternatives: string[];
  evidence: {
    role: DiscoveryEvidenceRole;
    method: DiscoveryEvidenceMethod;
    note: string;
    citations: Citation[];
  }[];
  gaps: DiscoveryGapInput[];
}
interface DiscoveryInput {
  changeReason: string;
  candidates: DiscoveryCandidateInput[];
  gaps: DiscoveryGapInput[];
}
```

Citationは既存citationSchemaと同じ。新規出力には行番号形式を指示し、quote形式は保存済み引用の互換用に限定する。候補を作れない知識不足はDiscoveryInput.gapsに入れ、候補固有の問いはcandidate.gapsに入れる。トップレベルのgapから候補IDを参照する仕組みは作らない。

Zodの上限は次に固定する。すべての文字列はtrimし、nullable以外は空文字を拒否する。任意情報の不明は空配列またはnullで表現する。

| 項目 | 上限 |
| --- | --- |
| candidates | 8件 |
| subject / object | 各160文字 |
| explanation / changeReason | 各800文字 |
| scope | 400文字またはnull |
| conditions / exceptions / alternatives | 各6件、各300文字 |
| candidate.evidence | 1〜6件 |
| evidence.note | 400文字 |
| evidence.citations | 1〜4件 |
| candidate.gaps | 3件 |
| discovery.gaps | 8件 |
| gap.question / reason | 各400文字 |

件数は出力目標ではなく上限。根拠が不足するなら0候補を返せる。形式検証は因果関係の科学的な妥当性を保証しない。

JSON Schemaへ変換する基礎スキーマと、parse後の意味整合チェック関数を分ける。Zodのrefineだけに検査を置き、JSON Schemaへ変換できなくなる構成は避ける。Codex側の構造化出力とworker側の意味整合検査の両方で検証する。

追加の決定的検査は以下に限定する。

- correlates_withの場合はcorrelationDirectionがnullでない。他のrelationはnull。
- supportedにはsupports、refutedにはcontradicts、disputedには両方のroleを最低1件必要とする。
- basis=inferenceかつcauses/increases/decreases/enables/inhibitsの場合、supportedを拒否し、hypothesis・disputed・insufficient_evidence・refutedのみ許す。
- experiment等のmethodは資料の記述に基づく分類であり、ラベルだけでassessmentを自動昇格しない。
- assessmentとroleの整合以外に、件数からconfidenceを算出しない。

### 13.3 保存型

```ts
interface DiscoveryEvidence {
  role: DiscoveryEvidenceRole;
  method: DiscoveryEvidenceMethod;
  note: string;
  evidenceIds: string[];
}
interface DiscoveryCandidate extends Omit<DiscoveryCandidateInput, "evidence"> {
  id: string;
  evidence: DiscoveryEvidence[];
}
interface WorldModelDiscovery {
  schemaVersion: 1;
  basedOnArtifactVersion: number;
  changeReason: string;
  candidates: DiscoveryCandidate[];
  gaps: DiscoveryGapInput[];
}
// packages/contracts/index.ts の既存Artifactへの追加:
// worldModelDiscovery?: WorldModelDiscovery;
```

保存型のZodスキーマも用意し、export時に検証する。idの生成規則は次とする。

1. subject、object、scope、conditionsの各文字列をNFC正規化・trimする。表示文自体は書き換えない。
2. conditionsは正規化後に重複排除し、標準の文字列sortを行う。
3. correlates_withだけは両端をsortする。その他の関係は向きを保持する。
4. `[subject, relation, object, scope, conditions, correlationDirection]`をJSON.stringifyする。
5. `wmc:` + SHA-256の先頭24桁をIDとする。利用範囲は調査内に限定する。

explanation、assessment、根拠の追加だけではIDが変わらない。条件・scope・関係・両端が変われば新しいIDとする。同一IDの複数候補は自動統合せず `DUPLICATE_DISCOVERY_CANDIDATE` で出力修正へ戻す。

## 14. 更新・根拠検証の関数契約

### 14.1 mergeDiscovery

```ts
mergeDiscovery(
  previous: DiscoveryInput | undefined,
  incoming: DiscoveryInput | null | undefined,
): DiscoveryInput | undefined
```

incoming=null/undefinedならpreviousを返す。それ以外はスキーマ検証後のincomingをそのまま返す。candidates/gapsの配列要素を自動マージしない。全候補を削除する場合は `{changeReason: "削除の具体的理由", candidates: [], gaps: []}` を明示する。旧版が履歴になるため、独立した削除履歴テーブルを作らない。

DraftとsectionUpdateSchemaには `worldModelDiscovery: discoveryInputSchema.nullable().optional()` を追加する。内部Draftでnullは保存せず、merge後にundefinedまたは実体へ正規化する。既存Jobの保存データにフィールドを補充しない。

全文応答も部分応答もmergeDiscoveryを必ず通す。applySectionUpdateの返すDraftへ同じmergeを組み込む。全文応答はworkerでmaterialize前にmergeする。`draft=null`は既存と同様に成果物全体の保持。navigationOnlyで非null draftを返した場合は `NAVIGATION_REQUIRES_NULL_DRAFT` とし、compatible providerでも書換えを受け付けない。

### 14.2 resolveCitationsとmaterializeDiscovery

```ts
resolveCitations(citations: Citation[], sources: Snapshot[]): Evidence[]
materializeDiscovery(
  input: DiscoveryInput | undefined,
  sources: Snapshot[],
  artifactVersion: number,
): { discovery: WorldModelDiscovery | undefined; evidence: Evidence[] }
```

resolveCitationsは既存materialize内の以下を切り出す。

- sourceの存在・本文hashを確認する。
- quoteをlocateEvidenceで位置へ変換する、または行番号から原文を切り出す。
- 既存と同じ `e:` ID、snapshotId、quote、start、end、contextを生成する。
- evidence IDで重複排除する。

既存レポート・KnowledgeのrefsはresolveCitationsの結果を使って従来どおりClaimを作る。materializeDiscoveryはEvidenceだけを返し、Claimを生成しない。

materializeの返却形 `{artifact, knowledge, claims, evidence}` は維持する。discovery.evidenceを既存evidenceへIDで重複排除して追加し、artifact.worldModelDiscoveryへ結果を付ける。Artifact.claimIdsと通常Claim数は発見機能の有無で増やさない。

workerの既存 `for (const e of result.evidence)` により、候補引用もstate.cursorsの読了範囲検証に含まれる。publish時も同じ範囲検査を通す。検証失敗前にstate.draft、Artifact、Evidenceを保存しない。

### 14.3 export検証

packages/artifact/index.tsのvalidateArtifactに候補の独立検証を追加する。

- 保存スキーマが有効で、basedOnArtifactVersionがartifact.versionと一致する。
- 全evidenceIdsがdetail.evidenceに存在する。
- 各Evidenceのsource存在・hash・quote範囲一致を検査する。
- 通常のvalidateClaimsやArtifact.claimIdsとの一致検査は変更しない。

evidence.jsonには既存のArtifactとEvidence出力を通じて発見結果が含まれる。V0は静的report.html/report.mdへ専用セクションを追加しない。アプリのタブとevidence.jsonが発見結果の参照先であることをREADMEへ明記する。

## 15. Workerとプロンプトの接続手順

### 15.1 バージョンと旧実行

Store.createでuseDelivery=trueの新規Jobにのみ `worldModelDiscoveryVersion: 1` を追加する。旧Jobのconfig欠落は0として扱う。新規legacy/mockには付けない。worker統合テストでは明示的に1を設定する。新しい環境変数やUIスイッチは追加しない。無効時にcompatible providerが発見結果を返しても保存せず、`DISCOVERY_DISABLED`で既存の修正経路へ戻す。

worker入力に `worldModelDiscoveryEnabled: job.config.worldModelDiscoveryVersion === 1` を渡す。saved replayはフラグが明示的に1の場合のみ有効にする。既存fixtureをすべて新形式へ書き換えて互換テストを失わせない。

### 15.2 生成スキーマ

groundedSchemaのdeliverable_step分岐は、enabledに応じて次のスキーマを作る。

- 無効: discoveryフィールドをomitした旧形式を使用する。
- 有効・本文読解: discoveryフィールドをrequiredにし、nullまたはDiscoveryInputを許す。
- 有効・navigation: draftはnullのみ。候補の更新欄は作らない。
- 有効・最終化: discoveryフィールドはrequired nullable。新しい根拠は使わず保持を許す。

strictSchemaが全propertiesをrequiredに変えるため、optionalだけで旧形式互換を実現しようとしない。newContentあり・有効・previousなしの場合、初回のdiscovery=null/欠落はworkerで `DISCOVERY_INITIAL_RESULT_REQUIRED` とする。候補がない場合にも空のDiscoveryInputを要求し、未生成との区別を成立させる。

以後のnullは保持として許す。compatible providerは構造化出力の強制がないため、workerで同じ検証を行う。全sourceIdのenum束縛は新しい引用フィールドにも適用されることをcodex-unitsで確認する。

### 15.3 プロンプト分岐

既存deliverableInstructionsへ無条件に追記しない。world-model-discovery用の指示定数をdeliverable-prompts.tsへ追加し、packages/prompts/index.tsのprompt関数でenabledの場合だけsystemに結合する。無効時のsystemHashを変えない。

本文読解用に以下を指示する。

- 新規に読んだ本文と既存候補から、元のテーマに関係する候補だけを生成・更新する。
- 新たな根拠がなければnullで保持する。初回は空結果でも実体を返す。
- 全体置換なので、維持する候補も出力に含める。
- 前述の相関・因果・推論・条件・反証の規則を守る。
- 変更・削除理由をchangeReasonへ書く。
- 元の依頼への回答を妨げるgapのみrequiredとし、任意の派生的な問いはoptionalとする。
- required gapは既存openQuestionsにも同じquestionを含める。optional gapは入れない。
- 候補数を埋めるために関係を推測しない。

本文読解の全文形式はDraftに既存候補が含まれる。部分更新形式では `worldModelDiscoveryState` として既存候補全文を別途渡す。

### 15.4 探索用の要約と終了判定

```ts
discoveryNavigationContext(input: DiscoveryInput | undefined): {
  candidates: { subject: string; relation: DiscoveryRelation; object: string;
    assessment: DiscoveryAssessment; conditions: string[] }[];
  gaps: DiscoveryGapInput[];
} | undefined
```

candidatesは保存順に先頭8件。gapsはcandidate.gapsとトップレベルgapsを結合し、kind+questionで重複排除、requiredを先にして最大8件とする。全文引用・Evidence・explanationはnavigationへ渡さない。

workerはnavigation入力へこの要約を追加する。有効時だけnavigationInstructionsへ「requiredな問いを優先し、条件や反証を調べる。optionalのgapだけで終了を妨げない」を結合する。

required gapのquestionがDraft.openQuestionsにない出力は `DISCOVERY_REQUIRED_GAP_NOT_IN_OPEN_QUESTIONS` とする。これにより既存のfinish.satisfied検査を再利用する。解決済みgapは次の明示更新で取り除き、openQuestionsも更新する。別の終了状態や独立した充足スコアは導入しない。

### 15.5 保存と失敗

state.draftに正規化済みDiscoveryInputを保持し、既存saveトランザクション内でArtifactとEvidenceを保存する。candidate数・gap数をdeliverable.updatedイベントへ追加する。エラーは既存deliverable.invalidに残す。

予算枠・retry回数・max出力tokenを今回の実装で引き上げない。切り詰めたJSONを受理せず、既存の修正1回・部分終了を使う。入力と生成コストの増加は品質比較で検証する。タブ用の追加LLM呼出しは0回であることをfixtureの呼出し履歴で検証する。

## 16. 表示仕様と改稿時の扱い

### 16.1 selectDiscoveryArtifact

```ts
selectDiscoveryArtifact(artifacts: Artifact[]): {
  artifact: Artifact | undefined;
  stale: boolean;
}
```

配列の並びに依存せずversion最大のArtifactを最新版とする。worldModelDiscoveryがある中でversion最大を選ぶ。見つからなければartifact=undefined、stale=false。選択版が最新版と異なるならstale=true。空のcandidatesでも生成結果として選ぶ。

これにより改稿処理への候補コピーは不要になる。stale=trueなら「レポートはvNに更新されています。以下はvMの調査時点の候補で、再評価されていません」と常時表示する。過去の候補を最新版の成果と呼ばない。

### 16.2 コンポーネント

WorldModelDiscoveryのpropsは `{detail: JobDetail}` のみ。useQuery・useMutation・useEffectによる生成処理を追加しない。main.tsxの既存pollingデータを使う。

- 両タブ配列のmemory直後へ `["world-model", "ワールドモデル発見"]` を追加する。
- `tab === "world-model" && d` の分岐でコンポーネントを表示する。
- 先頭に登録未実施の説明、参照版、実行中なら「調査途中」、fixtureなら「検証用データ」を表示する。
- cardsは保存順。相関は「↔」、その他は「→」。depends_onはsubjectがobjectに依存する向きで表示する。
- labelsはRecord型で全enum値を網羅する。未知enumを成功表示へfallbackしない。
- hypothesis=仮説、supported=支持する根拠あり、disputed=証拠が競合、insufficient_evidence=判断不能、refuted=反証あり。
- basisは「資料に記載」「根拠からの推論」。支持表示には「LLMによる評価・独立審査なし」を付ける。
- conditions空は「条件の記載なし」、exceptions空は「例外の記載なし」。無条件成立・例外なしと言い換えない。
- scope=nullは「適用範囲は未確認」。
- 根拠はrole別のdetailsに並べ、note、method、引用、原典リンクを表示する。
- EvidenceとSnapshotの解決はdetail.evidenceとdetail.sourcesから行う。欠落時は「根拠を参照できません」と表示し、存在しないリンクを作らない。
- PDFリンクは既存pdfEvidenceUrl/pdfEvidencePagesを再利用する。
- 引用と説明はReactの通常テキスト出力。dangerouslySetInnerHTMLは使わない。
- 既存memory-*の見た目を参考にし、新規固有クラスはworld-model-*とする。タブ列の折返しまたは横スクロールを確認する。

空状態は13節の候補配列だけでなくトップレベルgapsも表示する。候補0件・gapありを「結果なし」で丸ごと隠さない。

## 17. 実装チケットと完了条件

次の順に実施する。各チケットで差分と対象テストを確認してから次へ進む。全体リファクタ、プロバイダー変更、他プロジェクトの変更は行わない。

| ID | 作業 | 完了条件 |
| --- | --- | --- |
| WM-01 | schemaファイル、型、列挙値、上限、保存型、Artifactのtype追加 | schemaの正常・異常・空結果テストが通る |
| WM-02 | 引用処理切出し、materializeDiscovery、ID、Evidence統合 | 既存引用テスト不変。候補だけではClaimが増えない |
| WM-03 | mergeDiscovery、Draftと部分更新、保存・export検証 | null保持・空削除・旧データ・往復保存が通る |
| WM-04 | Store.createフラグ、生成スキーマ、prompt分岐 | 旧Jobのスキーマ／systemが変わらず、新規両providerが対応 |
| WM-05 | worker入力、初回検査、navigation要約、gap終了条件 | 全文／部分更新／再開／失敗の統合テストが通る |
| WM-06 | view selector、タブ、カード、空状態・旧版表示 | UIテストと両幅のE2Eが通る |
| WM-07 | 全体回帰、品質比較、READMEと実装記録更新 | verify・E2Eの結果、live未実行を含む制約が記録される |

WM-01〜03は新規生成をまだ有効にしない状態で成立させる。WM-04〜05が揃って初めて新規Jobで生成可能にする。コードが揃わない中間状態を稼働workerへ反映しない。

## 18. テストケース一覧

表のIDをテスト名かコメントへ残す。本文の科学的意味を機械テストだけで保証したと報告しない。

| ID | 入力・操作 | 期待結果 | 配置 |
| --- | --- | --- | --- |
| S01 | discoveryフィールドのない旧Draft | 従来どおりparse・materialize可能 | world-model-discovery.test.ts |
| S02 | 候補0・gap0・changeReasonあり | 生成済み空結果として保存 | 同上 |
| S03 | 上限超過、空のsubject、未知enum | 拒否 | 同上 |
| S04 | 相関なのに方向null／非相関に方向あり | 拒否 | 同上 |
| S05 | supportedでsupportsなし、disputedで反証なし | 拒否 | 同上 |
| S06 | inferenceの因果候補をsupportedにする | 拒否。hypothesisなら受理 | 同上 |
| S07 | 評価・根拠だけ変更／条件を変更 | 前者は同じID、後者は別ID | 同上 |
| S08 | 相関の両端交換／因果の両端交換 | 前者は同じID、後者は別ID | 同上 |
| S09 | 同一IDの候補2件 | 重複エラー。勝手に統合しない | 同上 |
| M01 | 既存候補にnullまたは省略を更新 | 候補を保持 | 同上 |
| M02 | 理由付き空結果／理由のない置換 | 前者は削除、後者は拒否 | 同上 |
| M03 | 全文更新／applySectionUpdate | 同一の保持・置換規則 | 同上 |
| E01 | レポートと候補が同じ引用 | Evidenceは重複なし。Claim数は不変 | 同上 |
| E02 | 候補だけが未知source／hash不一致を参照 | materialize失敗 | 同上 |
| E03 | 発見結果のEvidence欠落・改ざん | validateArtifact失敗 | 同上 |
| E04 | 保存型のbasedOnArtifactVersion不一致 | export失敗 | 同上 |
| P01 | enabled=false／config欠落 | 旧promptと旧生成schema。発見欄なし | codex-units.test.ts |
| P02 | enabled=trueの全文／部分更新 | nullableの発見欄必須。引用sourceIdが束縛済み | 同上 |
| P03 | navigationOnly=true | draft=nullしか許されない | 同上 |
| W01 | 初回読解でdiscovery欠落／null | 修正へ。空の実体なら成功 | world-model-discovery-engine.test.ts |
| W02 | 新規読解→候補生成→navigation→次読解 | 候補保持。navigation入力は要約のみ | 同上 |
| W03 | 候補の引用がcursorsより先 | CITATION_NOT_READ。最後の正常結果維持 | 同上 |
| W04 | required gapがopenQuestionsにない | 専用エラーで修正へ | 同上 |
| W05 | optional gapのみ残り他の問いは充足 | satisfied=trueを許す | 同上 |
| W06 | 不正出力が修正後も続く | 既存の部分終了。追加retryなし | 同上 |
| W07 | 保存後Storeを閉じて再開 | 候補・引用・ID保持。既存版不変 | 同上 |
| W08 | 同じ入力で機能off/onのfixture実行 | 発見専用LLM呼出し増加なし | 同上 |
| W09 | 旧Jobを再開 | 発見生成は始まらない | 同上 |
| U01 | 未生成／生成済み空／候補0でgapあり | それぞれの説明と問いが表示される | world-model-discovery-ui.test.tsx |
| U02 | 相関、支持、競合、反証の候補 | 向き・評価・role別根拠が正しく表示 | 同上 |
| U03 | 最新版に発見なし、旧版にあり | 旧版注意と版番号を表示 | 同上 |
| U04 | 最新版に空結果、旧版に候補あり | 最新の空結果を選ぶ | 同上 |
| U05 | 調査AからBへ切替 | Aのカードが残らない | 同上 |
| U06 | タブクリック | POSTやLLM実行を起動しない | E2E |
| U07 | 長文・多引用・mobileとdesktop | タブとカードが操作でき、横にはみ出さない | E2E |
| X01 | export→evidence.json読込 | 候補とEvidenceの参照を復元可能 | world-model-discovery.test.ts |
| X02 | ResearchEngine projection | 新しいcapabilityを宣言せず通常出力を維持 | research-adapter.test.ts |

workerテストはtests/deliverables.test.tsのsetup/run/fixture providerの方式に合わせる。本番DBを使わず一時ディレクトリのStoreを作り、finallyで閉じて削除する。UIテストはtests/helpers/fixturesを使う。E2Eは既存の専用サーバーへfixtureを投入し、live APIを呼ばない。

## 19. 検証コマンドと品質比較

実装後、次を順に実行する。計画書の更新だけの段階ではdocs:checkのみでよい。

```sh
bun run typecheck
bun --bun vitest run tests/world-model-discovery.test.ts tests/world-model-discovery-engine.test.ts tests/world-model-discovery-ui.test.tsx tests/deliverables.test.ts tests/codex-units.test.ts tests/research-adapter.test.ts
bun run verify
bun run verify:e2e
```

既存coverage基準はlines/functions/branches/statementsの各80%。閾値を下げない。既存障害がある場合は変更由来か切り分け、失敗を伏せて完了扱いしない。

品質比較には同じ保存資料を使い、次の4テーマ相当のケースを用意する。

1. 条件付きの性能改善: 条件を保存できるか。
2. 相関のみの報告: 因果を断定しないか。
3. 支持資料と反証資料の組合せ: 両方を保持できるか。
4. 関係を示さない定義中心の資料: 候補を捏造せず空結果にできるか。

off/onで、プロバイダー、モデル、reasoning、資料、予算を揃える。候補・根拠・レポート・Knowledge・終了理由・入力/出力token・読解資料数を保存して比較する。重大な根拠捏造、相関から因果確定、必須条件の脱落が1件でもあれば受入不可。通常レポートの必須回答がoffより欠落した場合も修正する。

固定LLM応答のfixtureは配線確認であり、この品質比較の代用にはしない。実モデル比較を行っていない場合は「実装・回帰確認済み、実調査品質は未確認」と記録する。tokenの増加を許容するかは実測を見て判断し、未測定の改善率や許容率を作らない。

## 20. 引き継ぎ時の最終チェックリスト

- [x] 変更範囲はWM-01〜07のみ。Phase 5、外部登録、他タスクへのメッセージ送信を含めていない。
- [x] 最新コードの該当関数を再確認し、行番号だけに依存して編集していない。
- [x] 通常Claim、候補、Evidenceの責務が分離されている。
- [x] 旧Jobと旧fixtureを維持するテストが残っている。
- [x] null保持、空削除、初回空結果、改稿後の旧版表示が実装されている。
- [x] UIだけ、あるいはpromptだけの実装で完了としていない。
- [x] テスト結果と品質評価の範囲をREADME／実装記録に記載した。
- [x] 未実装・未検証事項を完了報告へ明記した。
