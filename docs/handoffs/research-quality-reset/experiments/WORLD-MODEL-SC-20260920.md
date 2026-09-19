# World Model発見 SystemContext試験（2026-09-20）

探索モデルは `gpt-5.6-luna` / reasoning `low`。通常API・worker経路。過去調査の再生成は行わない。

## 目的

新規deliverables-v1で `worldModelDiscovery` が実際に生成されるか、相関と因果の混同・定義からの捏造を抑えられるかを、過去に使った短いテーマで確認する。レポート品質の80点達成実験ではない。

## テーマ

過去の回転から2件を選ぶ。

1. `DeepSeek flash 4.1` — 性能主張が多く、比較対象なしの因果断定が起きやすいかを見る。
2. `可逆圧縮` — 定義中心の資料になりやすく、空候補を捏造せず残せるかを見る。

## 予算

入力1,000,000、出力100,000、queries 8、rounds 8、documents 16、urls 24、requests 80、wallMs 1,200,000、depth 4。

## 変更範囲

執筆・探索の本体SystemContextは変えない。`worldModelDiscoveryInstructions` と `worldModelDiscoveryNavigationInstructions` だけを段階的に変える。

## 試行計画

5回。1仮説を見たあとで指示を調整する。

|試行|テーマ|SystemContext|
|---|---|---|
|T1|DeepSeek flash 4.1|v1 定義空結果・相関ロック・supported条件|
|T2|可逆圧縮|v1 同じ|
|T3|劣っていたテーマ|v2（T1/T2の失敗に合わせる）|
|T4|残りのテーマ|v2|
|T5|その時点で弱いテーマ|v3|

## 判定

各試行で次を記録する。正常完了点ではない。

- job status / reason、資料数、入力・出力token
- `worldModelDiscovery` の有無、候補数、gap数
- 相関を因果へ上げていないか
- 条件・比較対象の脱落
- 定義だけの資料から候補を捏造していないか
- 発見専用の追加LLM呼出しが増えていないか（deliverable_step / episode 以外がないこと）

重大な根拠捏造、相関の因果確定、必須条件の脱落が1件でもあればその版の指示は不合格とする。
