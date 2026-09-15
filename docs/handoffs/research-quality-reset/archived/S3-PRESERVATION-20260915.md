# S3 段落保持の具体化 — 不採用

基準3dbfffc（S1/S2なし）、候補7029debab3a1a4441379b795f43291bcb913eb73、保存codex/experiment-incremental-s3-20260915、差し戻しd6e394c83b8e。

保持指示1文を具体化した。全verify成功。PG固定入力ではSQL/期間例の保持が改善、入力+38/出力+192だった。liveでは最初の更新で既存6段落保持。しかし次の更新で旧資料UUIDが欠け、訂正でも修復できず、公式資料を読んだ後の草稿を保存できないまま終了した。PG基準69→候補59。候補を戻し、コードと全証跡を保存した。生成の揺れと読解順の差があるためUUID欠落の原因を指示変更と断定しない。

[配点・実行ID・費用・反証](../experiments/INCREMENTAL-20260915.md)。liveはdata/evaluations/incremental-20260915/pg-s3、予備診断はpreservation-replay-*。次は引用元IDをschemaで有限候補に限定するS4Cを独立検証する。
