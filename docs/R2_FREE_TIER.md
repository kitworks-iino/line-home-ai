# R2 Free Tier / 課金境界の扱い

## 結論

Cloudflare R2の無料枠は**ハードクォータではありません**。R2 subscriptionを有効化したPay-as-you-goアカウントでは、無料枠を超えてもR2 APIが自動停止したり容量超過エラーになったりせず、超過分が従量課金されます。

このHome AIは、当初設計どおりR2を画像・動画・音声・ファイルの保存先として維持します。その上で、R2 Standardの無料ストレージ枠そのものに合わせたハードガードを実装しています。

## Cloudflare公式の無料枠（2026-09-03時点）

R2 Standard:

- Storage: 10 GB-month / month
- Class A: 1,000,000 operations / month
- Class B: 10,000,000 operations / month
- Egress: free
- DeleteObject: free operation

CloudflareのStorage課金は、請求期間中の**各日のピーク保存量の平均**をGB-monthとして計算します。したがって、このアプリがR2の瞬間保存量を常時10,000,000,000 bytes以下に保てば、このアプリ由来のStorage使用量は10 GB-monthを超えません。

## このアプリのハードガード

`wrangler.jsonc`:

```json
"R2_STORAGE_HARD_LIMIT_BYTES": "10000000000"
```

これは5GBや8GBのような任意の安全余裕ではなく、R2 StandardのStorage無料枠と同じ**10 GB（decimal）**です。

メディア保存前に、WorkerはR2 `ListObjects` で実際に現在存在するオブジェクトの`size`を全ページ合計します。

- `現在の実保存bytes + 新規添付bytes <= 10,000,000,000` → 通常保存
- 超える → バイナリ本体を保存しない

上限超過時もLINEイベント自体や会話履歴を壊さないため、R2には0-byteの専用marker objectを保存します。Geminiへ過去メディア文脈を組み立てる際、そのmarkerを検出した場合は「R2無料ストレージ上限のため本体を保存しておらず、内容は参照できない」と明示します。

## `/usage`

承認済みメンバーはLINEグループで次を実行できます。

```text
/usage
```

R2を実際にListして、現在の保存量・10GBハード上限に対する使用率・オブジェクト数を表示します。D1の推計値ではなくR2の実オブジェクトサイズを集計します。

## なぜClass A/Bを同じ方式でアプリ側ハード停止しないか

R2の無料枠にはStorage以外にClass A/B操作数がありますが、Worker bindingからCloudflareの**請求上の月次Class A/B累計**を正確なauthoritative値として取得してハード停止する仕組みは、このアプリの通常R2 binding APIにはありません。ローカルカウンタを持つことはできますが、Dashboard操作・Wrangler provisioning・将来の別クライアント操作などを含むCloudflare側の正式課金値とはズレ得ます。

また現在のHome AIのアクセスパターンは極めて小さいです。

- 1添付保存: 主に `ListObjects` + `PutObject`（Class A）
- AIのメディア参照: 1回答につき最大 `MAX_MEDIA_CONTEXT=3` の `GetObject`（Class B）
- 削除: `DeleteObject` はCloudflare公式上free operation

Class A 100万回/月、Class B 1000万回/月に対し、承認済み2人だけの家族LINE利用ではStorage 10GBの方が先に現実的な制約になります。

Class A/Bの正式値はCloudflare DashboardのBillable Usageをauthoritativeとします。Budget Alertは設定可能ですが、Cloudflare公式上**通知のみで利用停止・上限設定ではありません**。

## R2 subscriptionについて

初回利用時はCloudflare DashboardのR2画面でR2 subscriptionを有効化する必要があります。画面上の初期合計は$0.00で無料使用量が含まれますが、これは「無料枠を超えたら停止する契約」ではなく、超過分を従量課金するsubscriptionです。

そのため、本プロジェクトではR2を外すのではなく、必要な機能を維持しながらStorageについてアプリ側で10GBのハードガードを設けています。
