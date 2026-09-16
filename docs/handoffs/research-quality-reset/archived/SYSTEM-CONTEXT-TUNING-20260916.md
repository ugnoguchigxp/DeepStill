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

### L1結果: 分岐は改善、内容点は改善せず不採用

候補コミット `7c7a06d`、保存ブランチ `codex/experiment-system-context-l1-20260916`。`bun run verify` は37ファイル246テスト、typecheck/lint/format/build/docsを含め成功した。

|テーマ|実行ID|終了|入力/出力|点|候補分岐|
|---|---|---|---:|---:|---|
|gemini 3.8 live|`4f3a0162-da94-4df1-bbed-1791f985e6e3`|partial / unresolved_questions|16,759 / 923|6|到達。timeout後に別クエリへ進んだがbot challengeで資料0件|
|typescriptとwasm|`3adc0f16-6728-49ee-8abd-ce43440029c7`|partial / invalid_deliverable|204,570 / 31,151|82|未到達。内容差は候補効果に帰属しない|
|フロンティアモデルではAGENTS.mdは不要に|`809dfc84-8d33-40af-825c-6c7e48916872`|completed / satisfied|44,129 / 4,833|90|未到達。基準のtimeoutに対して候補時は初回検索成功で比較不能|

L1が狙った行動変化は確認できたが、唯一到達したテーマの固定評価点は6点のままで、入力は5,845、出力は275増えた。残る2テーマはL1分岐に入っておらず、内容改善を変更効果とは扱えない。主指標の改善を確認できないため不採用とし、保存ブランチを確認後にmainでrevertする。

### S1結果: Knowledge誤分類は改善したが、正常完了・費用が悪化したため不採用

候補コミット `cc22417`、保存ブランチ `codex/experiment-system-context-s1-20260916`。書き込み用SystemContextだけを変更し、navigation用SystemContext、schema、制御ロジックは変更していない。`bun run verify` は37ファイル245テスト、typecheck/lint/format/build/docsを含め成功した。

書き込み用SystemContextは7,661文字から3,357文字へ56.2%短縮された。`typescriptとwasm` では書き込み呼び出し数は基準・S1とも8回であり、短縮自体は監査上確認できた。一方、navigation呼び出しは5回から14回へ増え、全入力tokenは減らなかった。

|テーマ|実行ID|終了|入力/出力|点|比較判定|
|---|---|---|---:|---:|---|
|gemini 3.8 live|`c3418329-ddd6-4f9f-b8ad-6c101c8c4d81`|partial / unresolved_questions|10,910 / 566|6|初回検索timeout、資料0件。書き込み変更へ未到達|
|typescriptとwasm|`171908e5-d3ea-4e74-9e25-b4361fe78bc8`|partial / invalid_deliverable|294,154 / 33,795|80|比較対象。Knowledge誤分類は消えたが別の検証エラーで失敗|
|フロンティアモデルではAGENTS.mdは不要に|`1869a25f-3204-49d9-b05b-adcfc64f2a5b`|partial / unresolved_questions|10,957 / 537|6|初回検索bot challenge、資料0件。書き込み変更へ未到達|

`typescriptとwasm` の80点内訳は、対象同定12/15、探索・情報増分17/25、根拠18/20、説明17/20、Knowledge 10/12、Episode 6/8。6資料・21 claimから、AssemblyScriptの型制約、線形メモリ、GC、UTF-8/UTF-16境界を条件付きで説明し、Knowledge 5件をすべて `rule / skill=null` にできた。基準の `SKILL_REQUIRES_PROCEDURE` は再発しておらず、S1が狙った局所的な行動改善は見られた。ただし、短い依頼の別解釈である「他言語製WasmをTypeScriptから使う」側の説明は基準より薄く、最終操作は `WITHHELD_SOURCE_ALIAS_USE_INDEPENDENT_EVIDENCE` で無効になった。

ガードレールは悪化した。比較可能なテーマの終了状態は基準と同じ `partial / invalid_deliverable` で、入力は175,647から294,154へ67.5%、要求数は26から48へ84.6%増えた。出力も30,085から33,795へ増えた。固定内容点は3点上がったが、正常完了を回復せず、大幅な費用増と対象範囲の後退を伴うため、総合改善とは判定しない。S1は不採用とし、保存ブランチを残してmainからrevertする。

## 実験全体の使用量

|段階|入力token|出力token|要求|query|保存資料|
|---|---:|---:|---:|---:|---:|
|基準|197,512|31,315|34|4|6|
|L1|265,458|36,907|47|6|8|
|S1|316,021|34,898|56|7|6|
|合計|778,991|103,120|137|17|20|

外部検索障害で資料0件だった対は、SystemContext変更の勝敗から除外した。今回の結論は、検索回復をプロンプトへ寄せず制御状態として扱うこと、書き込み契約の短縮と探索終了規則の変更を同時に行わないこと、alias/withheld由来の訂正失敗を具体的な状態遷移として次の独立実験にすること、の3点である。
