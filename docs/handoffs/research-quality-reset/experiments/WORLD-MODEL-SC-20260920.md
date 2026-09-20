# World Model発見 SystemContext試験（2026-09-20）

探索モデルは `gpt-5.6-luna` / reasoning `low`。通常API・worker経路。過去調査の再生成は行わない。基準コミットは発見機能導入後の `d9ed2b3`。候補保存ブランチは `codex/experiment-wm-sc-20260920`。

## 目的

新規deliverables-v1で `worldModelDiscovery` が実際に生成されるか、相関と因果の混同・定義からの捏造を抑えられるかを、過去に使った短いテーマで確認する。レポート品質の80点達成実験ではない。

## テーマ

過去の回転から2件を選んだ。

1. `DeepSeek flash 4.1` — 性能主張が多く、比較対象なしの因果断定が起きやすいかを見る。
2. `可逆圧縮` — 定義中心の資料になりやすく、空候補を捏造せず残せるかを見る。

## 予算

入力1,000,000、出力100,000、queries 8、rounds 8、documents 16、urls 24、requests 80、wallMs 1,200,000、depth 4。

## 変更範囲

執筆・探索の本体SystemContextは変えない。`worldModelDiscoveryInstructions` と `worldModelDiscoveryNavigationInstructions` だけを段階的に変えた。

## 試行結果

|試行|テーマ|SC|実行ID|終了|資料|入力/出力|発見|備考|
|---|---|---|---|---|---:|---|---|---|
|T1|DeepSeek flash 4.1|v1|`5ca4d1ac-82b8-40bf-8d28-7fd4c44c39e6`|partial / invalid_deliverable|2|78,137 / 12,610|候補1件、hypothesis / enables|`DISCOVERY_REQUIRED_GAP_NOT_IN_OPEN_QUESTIONS` が2回。実測なしの因果は supported にしなかった|
|T2|可逆圧縮|v1|`501032f4-2e79-4b24-9657-a18822c62688`|partial / unresolved_questions|0|11,012 / 542|未生成|DuckDuckGo timeout。発見分岐未到達。比較から除外|
|T3|DeepSeek flash 4.1|v2|`0ded7e57-23ae-4e82-a5a3-e4f9876ebb67`|partial / invalid_deliverable|4|178,355 / 28,106|候補3件|相関1件は hypothesis + correlates_with。required gap の欠落コピーが再発。UNDISCOVERED_URL 1回|
|T4|可逆圧縮|v2|`0489c21b-e353-419e-aa99-6310596954e3`|completed / satisfied|1|33,189 / 1,969|候補0件の生成済み空結果|e-Wordsの定義本文から関係を捏造しなかった。changeReasonに概念説明のため候補なしと明記|
|T5|DeepSeek flash 4.1|v3|`27d3376c-a333-4d85-aee9-93c6c186068c`|partial / unresolved_questions|0|11,010 / 515|未生成|再検索timeout。v3は読解へ到達せず。比較から除外|

発見専用のLLM kindは増えていない。deliverable_step と deliverable_episode のみ。

## SystemContext版

- v1 `1010092`: 定義なら空候補、一緒に動くなら相関、比較対象なしは supported にしない。
- v2 `22112ca`: required gap は同じ出力の openQuestions へ全文コピーする。
- v3 `65f1f99`: gap は原則 optional。著者・モデルカードは測定行がなければ hypothesis。mainに残している。

## 判定

World Model向け生成は、読解に到達した試行では動く。T1とT3で成果物に候補が残り、T4では定義資料から空結果を保存できた。

最も使える発見結果は **T3**（候補3、相関を因果へ上げない、条件付きの減少関係を記録）。定義資料の正しい空結果は **T4**。

残る欠陥は指示だけでは安定しない。lunaは required gap を openQuestions へコピーせず、`invalid_deliverable` で部分終了する。T5でv3を確認できていない。検索timeoutは発見指示の効果ではない。

80点評価や4テーマ実測比較の合格には使わない。fixture成功とも読み替えない。
