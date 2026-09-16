# 構造成果物トライアル（2026-09-16）

## 対象

過去履歴から次の3案を順に、独立して評価する。

1. R6: 保存済みの同一資料・同一operation入力を使う固定再生評価。
2. D2: 有効draftの保存と次行動の検証を分離する。
3. U3: 全文再生成ではなく節単位で成果物を更新する。

探索モデルは `gpt-5.6-luna` / reasoning `low`。live探索は共通実験ガイドの標準予算を使う。固定再生は新規Web検索・取得を行わず、live品質の代用にしない。

## R6: 固定再生評価

候補は、保存済みrun-detailとoperation IDから当時の作業入力を読み出し、現在の `deliverable_step` で再生成するCLIと、結果を決定的に検査する評価関数である。引用のmaterialize可否、節・段落・文字数、Knowledge、未解決点、既存段落の完全一致保持率、消えた節見出し、tokenを保存する。

provider不要の回帰テストでは、同じSnapshotに対する引用検証、段落保持、節脱落、不正sourceIdを確認する。providerを使う再生成は別レーンで、結果ディレクトリに `newWebResearch:false` と元job・operation・SystemContext hashを保存する。

### 変更前基準

- 元実行: `data/evaluations/incremental-20260915/pg-baseline/run-detail.json`
- operation: `delivery:25:deliverable_step`
- 出力: `data/evaluations/structural-trials-20260916/replay-baseline/`
- 同一資料再生のみ。入力21,027 / 出力4,175 tokens。
- 旧稿: 4節・15段落・2,562文字。再生成稿: 6節・14段落・1,979文字。
- 既存15段落の完全一致保持は0件。`その他の主な強化候補と具体例` 節が消えた。
- 引用とschemaは有効。したがって、引用不正ではなく全文再生成による表現変更・情報保持を比較する基準として使える。

R6は評価インフラであり、runtimeの探索動作を変更しない。verify通過後に独立コミットとして採用する。

## D2仮説: draftと次行動の検証分離

### 観測

現在は `{draft,next}` をparseし、draftをmaterializeした後、nextのURL・read・search・finishを検証する。nextだけが不正でも一つのcatchへ入り、有効な新稿をstateへ保存せず、同じ本文と旧稿を含む執筆呼び出しで全体を再生成する。この経路は有効説明の消失、訂正費用、最終 `invalid_deliverable` を生む。

### 候補

draftのschema・引用・読了範囲が有効なら、次行動の検証前に「保存可能」と判定する。nextが不正の場合も、新稿・Knowledge・claim・evidenceを同一transactionで保存し、本文と新規資料を外したnavigation-only訂正へ移る。訂正上限は増やさず、訂正したnextも不正なら従来どおりpartial終了する。

### 期待と反証

- 期待: 有効な新稿が不正nextで失われず、訂正入力が小さくなる。
- 反証: 不正引用や不完全Knowledgeまで保存する、同じ本文を飛ばす、修正呼び出しが増える、内容・正常完了・費用が改善しない。

### D2初期結果

- 候補コミット: `8921f96`。保存ブランチ: `codex/experiment-structural-d2-20260916`。
- `bun run verify` 成功。38ファイル248テスト。既存lint warningのみ。
- deterministic回帰では、有効draftと引用を保存した後、`URL_ALREADY_ATTEMPTED` を含む訂正入力が `navigationOnly=true`、`draft` なし、`newContent=null` になり、元の執筆入力より小さくなった。最終jobはcompletedとなり、保存本文を保持した。

live初期対は `typescriptとwasm`。

|条件|実行ID|終了|資料|入力/出力|D2分岐|
|---|---|---|---:|---:|---|
|基準 `a6a5151`|`d8339324-3c9b-4946-a093-1f441d298e57`|partial / unresolved_questions|0|10,881 / 632|初回検索timeoutのため未到達|
|D2候補 `8921f96`|`904271b2-fe9b-455d-aef4-e7a1beebef8b`|partial / unresolved_questions|6|161,784 / 27,500|`deliverable.invalid` 0件で未到達|

候補側は6資料・7回の成果物更新まで進み、別の検索timeout後に既知資料を使って未充足終了した。重大なruntime回帰は観測していないが、基準側は資料0件で、候補側にもD2対象エラーが発生していない。したがって内容点や正常終了をD2の効果とは扱わない。

D2は機械的不変条件としては期待どおりだが、live品質改善は未検証のため採用保留とする。U3へ効果を混ぜないようmainでは一度revertし、候補ブランチを保持する。

## U3仮説: 節単位更新

### 観測

固定再生では既存15段落の完全一致が0件で、1節が消えた。過去S2/S3/S4Cでも新資料統合後に具体例・条件・料金・機構説明が脱落した。保持指示だけでは防げなかった。

### 候補

節へ安定IDを付け、LLM出力を「保持・置換・追加・削除」の操作へ限定する。変更対象外の節はコード側で保持する。明示的な削除には理由を要求し、引用・Knowledge・未解決点の検証は既存契約を維持する。D2と混ぜず、D2の採否確定後に独立候補として実装する。

### 期待と反証

- 期待: 同一資料再生で無関係な節・段落の保持が増え、liveで説明脱落が減る。
- 反証: 重複、誤情報の固着、節順序の破壊、schema・入力の肥大、全文更新より高い費用、内容点または正常完了の悪化。
