# D1添付ストレージ（v1.7.0）

Home AIはR2を使わず、会話DBとは別のD1 MEDIA_DBに添付を保存します。画像・音声・動画・ファイルの受付、対応形式のGemini参照、送信取消、管理者のデータ削除を維持します。対応外形式は保存してメタデータで説明し、内容を見たとは回答しません。

## 容量・費用

元データ合計300,000,000 bytes（300 MB）、1ファイル16,777,216 bytes（16 MiB）が上限です。1 MiB単位でbase64 TEXT化し、符号化後もD1の2 MB行制限内に収めます。Base64の約4/3の増加とメタデータ・索引分を考慮して、D1 Freeの500 MB/DB内で運用します。小さなファイルが多数ある場合などDB上限が先に来た場合も、保存失敗として通知します。

旧R2の10 GBと同じ容量ではありません。既存データの期限短縮、自動間引き、自動課金有効化は行いません。上限では新規添付を保存せずLINEに通知します。/usageで使用量を表示します。

Workers FreeのD1日次上限到達時はクエリがエラーになり、既存データは保持されます。アプリはプランを変更しません。GeminiやLINEなど外部サービスの条件は別であり、R2撤去だけで全サービス無料を保証するものではありません。

公式資料：
https://developers.cloudflare.com/d1/platform/limits/
https://developers.cloudflare.com/d1/platform/pricing/
https://developers.cloudflare.com/d1/worker-api/d1-database/

## 整合性・安全性

メタデータ、全チャンク、容量カウンタを1つのD1 batchトランザクションで更新します。SQLトリガーで合計容量を検査し、並行保存でも上限超過を防ぎます。失敗時は全体をロールバックします。同じメッセージID・同じ内容の再保存は重複計上せず、同じキーの異なる内容は拒否します。取得時にはチャンク数・順序・サイズ・SHA-256を検証します。

LINEのダウンロードにはタイムアウトとストリームサイズ上限を適用します。送信取消は添付を先に消し、そのキーだけを取消済みとして管理して再配信で復活させません。管理者の全データ削除では当該グループだけを処理します。家庭内添付の公開URLは作りません。

## 検証

npm test：回帰テスト、実SQLiteトランザクション、容量境界、16 MiB、重複、途中失敗、取消、LINEイベント、添付のGemini入力を検証します。

npm run test:runtime：Miniflare/workerdのD1バインディングで0 bytes、1 MiB超、16 MiBの保存・取得・重複・取消・削除を検証します。

本番の固定合成テストは認証済みCloudflare APIからMEMORY_QUEUEへ、次のJSONを送ります。公開HTTP管理エンドポイントは作りません。

```json
{"kind":"verify-storage","release":"1.7.0","runId":"unique-run-id","notify":false}
```

専用の合成グループキーでD1に保存・再取得・削除し、合成添付の検証文字列でGemini応答を確認します。家庭内会話を外部テストに送りません。LINEの認証と既存Webhookも照合します。notify=trueの場合だけ、月200件無料枠と残量を確認できれば既存グループに1通の検証メッセージを送ります。

結果はapp_stateのstorage_verification_latestに保存し、/healthでも表示します。秘密値や家庭内会話は含めません。passed以外を成功と扱ってはいけません。

## 配備

DBとMEDIA_DBは既存D1の明示IDに接続します。r2_bucketsや旧MEDIAを残さず、プレビューURLを無効にします。main更新後にCI、Cloudflare Builds、本番バージョンを確認します。旧R2の物理削除や請求契約は別事項です。旧バケットにデータが増えていた場合は切替前に移行し、検証前に削除しません。
