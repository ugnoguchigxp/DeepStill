# 探索SystemContext調整実験（2026-09-16）

## 条件

- 基準コミット: `16524a3`
- 探索モデル: `gpt-5.6-luna` / reasoning `low`
- 予算: queries 8、rounds 8、documents 16、urls 24、input 1,000,000、output 100,000、requests 80、wall 1,200,000 ms、depth 4
- テーマ: `gemini 3.8 live`、`typescriptとwasm`、`フロンティアモデルではAGENTS.mdは不要に`
- 評価: 共通ガイドの100点基準。終了状態と重大な成果物不整合は点数とは別のガードレールとして扱う。
- 生ログ: `data/evaluations/system-context-tuning-20260916/`

## 過去履歴参照前の観測と仮説

### 基準試行

|テーマ|実行ID|終了|入力/出力|暫定点|
|---|---|---|---:|---:|
|gemini 3.8 live|`9c67003a-0509-404a-b4f6-6a52ace6b32b`|partial / unresolved_questions|10,914 / 648|6|
|typescriptとwasm|`17fa2311-c5bc-4026-ab87-e8339360827e`|partial / invalid_deliverable|175,647 / 30,085|77|
|フロンティアモデルではAGENTS.mdは不要に|`3f49e647-2edf-4141-93f3-e7d854c8cc97`|partial / unresolved_questions|10,951 / 582|6|

`gemini 3.8 live` と `フロンティアモデルではAGENTS.mdは不要に` は、最初のDuckDuckGo検索がタイムアウトしただけで `searchUnavailable` となり、代替語・別切り口を試さず終了した。SystemContextは再検索を指示していたが、入力上の `remainingQueries=0` と `searchUnavailable` によって実行不能だった。これはプロンプト不足ではなく状態表現・制御の欠陥である。

`typescriptとwasm` は6資料を保存し、AssemblyScriptの線形メモリ、配置、GC、WIT/jcoの位置づけまで説明した。探索経路と成果物には情報増分があった。一方、手順型Knowledgeの不正な出力が `SKILL_REQUIRES_PROCEDURE` となり、訂正後も `invalid_deliverable` で終了した。内容点は高いが正常完了していない。

### L1: 一時的な検索障害の昇格を遅らせる

- 変更: direct searchのtimeout/network系エラーを一時的と分類し、最初の1回だけ別クエリを選べる状態へ戻す。2回連続なら検索不能へ昇格する。
- 期待: 基準で空成果物だった2テーマが代替検索へ進み、取得・読解・成果物生成が行われる。
- 反証: 代替検索が行われない、同一検索を繰り返す、検索障害時の要求数だけ増えて内容が増えない、または成功したテーマの品質が悪化する。
- リスク: 外部検索障害が継続している場合にLLM呼び出しと検索要求を1回余分に消費する。

### S1: 書き込みSystemContextを成果物契約中心に圧縮する

- 対象: L1の評価後に独立して実施する。L1が採用ならその上へ積み、L1が不採用なら基準へ戻してから行う。
- 観測: 本文統合時のSystemContextは探索判断、執筆、Knowledge、特定テーマ由来の例、終了規則が一つの長い段落群に混在する。TypeScript試行では有効な本文更新を続けた後、完全なprocedureを要求する契約に反するSkillを出し、訂正も失敗した。
- 変更仮説: 不変条件を「根拠付きレポート」「再利用可能なrule」「procedureを選ぶ条件」「次の1行動」に分け、テーマ固有の圧縮例を除き、重複した探索規則をnavigation用指示へ限定する。
- 期待: 入力tokenを減らし、ruleで十分な説明をSkillへ誤変換する率と `invalid_deliverable` を下げつつ、本文の機構・具体例・条件を維持する。
- 反証: 内容点、引用支持、Knowledge再利用性のいずれかが悪化する、必要な探索規則が欠落する、または入力削減だけで正常完了率が改善しない。

## 採否

実測後に追記する。テスト通過だけでは採用しない。
