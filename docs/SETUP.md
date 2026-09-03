# セットアップ手順 — 人間側はUI設定だけ

このリポジトリは、ソースコード編集やCLI実行を人間側に要求しない構成です。`main` をCloudflareへ接続した後、残る作業はLINE・Google AI Studio・Cloudflareの各UI設定だけです。

## 完成後の構成

専用LINEグループには次の3者だけを参加させることを推奨します。

- 飯野さん
- とちょ
- Home AI（LINE公式アカウント）

アプリ側では承認済み2ユーザー以外の通常発言を保存もGemini送信もしません。ただし、LINEグループに別の人間が物理的に参加している場合、Botの返信自体をその人から隠すことはできません。家族AI専用グループにしてください。

---

## 1. LINE公式アカウントを作成する

1. **LINE Official Account Manager** で新しいLINE公式アカウントを作成します。
2. アカウント名は `Home AI` を推奨します。コード自体は表示名には依存しません。
3. LINE Official Account Managerから **Messaging APIを有効化**します。
4. 作成されたMessaging APIチャネルを **LINE Developers Console** で開きます。
5. 次の2値を控えます。
   - `Channel ID`
   - `Channel secret`
6. LINE Developers Console → **Messaging API設定** → **グループトーク・複数人トークへの参加を許可する** を有効にします。
7. LINE公式アカウント側の標準「あいさつメッセージ」「応答メッセージ」が不要ならOFFにします。Home AIの回答と二重表示されるのを防ぐためです。

### アクセストークンについて

長期のMessaging APIアクセストークンを発行・保存する必要はありません。

このWorkerは `LINE_CHANNEL_ID` と `LINE_CHANNEL_SECRET` から、短時間有効のStateless Channel Access Tokenを自動発行・キャッシュします。401になった場合も1回だけ自動再発行します。

---

## 2. Gemini APIキーを作成する

1. **Google AI Studio** を開きます。
2. Gemini API用プロジェクトを作成または選択します。
3. APIキーを作成します。
4. 後でCloudflareのSecret `GEMINI_API_KEY` に入れるため控えます。

既定モデルは `gemini-3.7-flash` です。実装はGemini Interactions APIを `store:false` で使用します。

### 無料枠とプライバシー

Gemini 3.7 FlashにはFree Tierがありますが、Free Tierにはレート制限があります。またGoogleはFree Tierの送信内容を製品改善に利用する場合があると説明しています。家庭内会話をその条件で送信したくない場合は、有料Tierまたは別の実行基盤へ切り替えてください。

このアプリ自身が勝手に有料プランへアップグレードすることはありません。

---

## 3. CloudflareでR2を有効化する

**初回だけ必要です。ここを飛ばすと、Workerの初回Deploy時に `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` で失敗します。**

1. Cloudflare Dashboard → **Storage & databases → R2 → Overview** を開きます。
2. **R2サブスクリプションをアカウントに追加する** を選びます。
3. 画面上の開始時合計が `$0.00` で、R2 Standardの無料使用量が含まれていることを確認して有効化します。
4. **Bucketは手作業で作成しません。** 後続のWrangler deployが `MEDIA` bucketを自動プロビジョニングします。

### 重要: 「無料枠」は自動停止ではない

R2 subscriptionはPay-as-you-goです。Cloudflare R2の無料枠を超えても、Cloudflareが容量超過エラーで自動停止するわけではなく、超過分は従量課金されます。CloudflareのBudget Alertも通知だけで、ハード上限ではありません。

2026-09-03時点のR2 Standard無料枠:

- Storage: **10 GB-month / month**
- Class A: **1,000,000 operations / month**
- Class B: **10,000,000 operations / month**
- Egress: free
- DeleteObject: free operation

Home AIはR2を当初設計どおり維持しつつ、Storageについては**任意の安全余裕を取らず、無料枠そのものと同じ10,000,000,000 bytesをアプリ側ハード上限**にしています。新規添付の保存前にR2の実オブジェクト容量を全ページ集計し、保存後に10GBを超える場合だけバイナリ本体を保存しません。

詳細: [R2 Free Tier / 課金境界の扱い](R2_FREE_TIER.md)

---

## 4. CloudflareへGitHubリポジトリを接続する

Cloudflare Dashboardで以下を行います。

1. **Workers & Pages** を開きます。
2. Worker作成画面から **Import a repository / Git repositoryをインポート**する導線を選びます。
3. GitHubアカウントを接続します。
4. リポジトリ `kitworks-iino/line-home-ai` を選択します。
5. Production branchを `main` にします。
6. Worker名は **`line-home-ai`** にします。`wrangler.jsonc` の `name` と一致させます。
7. Build commandは空欄で構いません。
8. Deploy commandは **`npx wrangler deploy`** を使用します。
9. Deployします。

### D1 / R2 / Queuesは手作業で作らない

`wrangler.jsonc` ではD1、R2、QueueをリソースIDなしのbindingとして宣言しています。現行Wrangler/Cloudflareの自動プロビジョニングにより、初回Deploy時に必要なリソースが作成・bindingされます。

対象:

- D1 binding: `DB`
- R2 binding: `MEDIA`
- Queue: `line-home-ai-events`
- Dead Letter Queue: `line-home-ai-dead-letter`

`dead_letter_queue` に指定したQueueが未作成でもCloudflare側で作成されます。Cloudflare UIでリソース作成確認が表示された場合は許可してください。

**D1 migrationをCLIで実行する必要もありません。** Workerが初回アクセス時にスキーマを自己初期化し、将来の加算的migrationもコード側で処理します。

---

## 5. Cloudflareへ4つのSecretを設定する

初回Deploy後、Cloudflare Dashboardで対象Worker `line-home-ai` を開きます。

**Settings → Variables and Secrets** から、以下をすべて **Secret** として登録します。

| Secret名 | 入れる値 |
| --- | --- |
| `LINE_CHANNEL_ID` | LINE DevelopersのChannel ID |
| `LINE_CHANNEL_SECRET` | LINE DevelopersのChannel secret |
| `GEMINI_API_KEY` | Google AI StudioのAPI key |
| `SETUP_CODE` | 自分で決める十分長い秘密文字列（24文字以上推奨） |

`SETUP_CODE` は最初のLINEグループをこのWorkerへ一度だけ紐付けるために使います。GitHubへ書かないでください。

以下は `wrangler.jsonc` に設定済みなので通常は変更不要です。

- `GEMINI_MODEL=gemini-3.7-flash`
- `DEFAULT_THINKING_LEVEL=medium`
- `BOT_DISPLAY_NAME=Home AI`
- `MEMORY_BATCH_SIZE=24`
- `RECENT_MESSAGE_LIMIT=40`
- `MAX_MEDIA_CONTEXT=3`
- `R2_STORAGE_HARD_LIMIT_BYTES=10000000000`

CloudflareがSecret変更に対する再Deployを要求した場合は実行します。

---

## 6. `/health` でCloudflare側の準備完了を確認する

WorkerのURLは通常、次の形式です。

`https://line-home-ai.<あなたのworkers.devサブドメイン>.workers.dev`

ブラウザで次を開きます。

`https://<WorkerのURL>/health`

期待値:

```json
{
  "ok": true,
  "ready": true
}
```

`ready:false` の場合は4つのSecretのいずれかが未設定です。`/health` はSecretの中身を返さず、存在有無だけを確認します。

このアクセス時にD1スキーマも自己初期化されます。

---

## 7. LINE Webhookを接続する

LINE Developers Console → 対象Messaging APIチャネル → **Messaging API設定** で次を行います。

1. Webhook URLに次を設定します。

   `https://<WorkerのURL>/webhook`

2. **Webhookの利用 / Use webhook** をONにします。
3. **検証 / Verify** を実行します。
4. 成功表示になることを確認します。

LINEの検証時に `events: []` のWebhookが来ても、このWorkerは正常に200を返します。

---

## 8. Home AIを家族専用LINEグループへ追加する

1. 飯野さん・とちょだけの専用LINEグループを作成します。
2. `Home AI` のLINE公式アカウントを追加します。
3. 今後の管理者になる側が、グループで次を送ります。

`/setup あなたのSETUP_CODE`

例としてREADMEやコードに実値は保存しません。

成功すると、そのLINE `groupId` がこのWorkerの唯一の対象グループとして固定され、実行したユーザーがadminになります。

### 2人目を承認する

2人目がグループで送信:

`/join`

Home AIが参加申請コードを返します。

adminが送信:

`/approve CODE`

これで2人が承認済み家族メンバーになります。3人目の承認は拒否されます。

---

## 9. 動作確認

まず次を送ります。

`/status`

登録メンバーが `2/2` になっていることを確認します。

続いてR2の実使用量も確認します。

`/usage`

初期状態ではほぼ0 GB / 10 GBになります。

その後、たとえば次を試します。

- LINEの実際の `@Home AI` メンション
- `GPT、今日どうする？`
- `AI: この会話を整理して`
- Home AIの直前の返信をLINEの「返信」で引用して続ける
- `/deep 複雑な相談内容` — その1回だけThinkingをhighにする

2人だけで普通に会話している時は、Home AIは返答しません。ただし承認済み2人の会話は、後の文脈・要約・長期記憶のため保存されます。

---

## 10. 運用コマンド

- `/help` — コマンド一覧
- `/status` — 稼働状態と保存件数
- `/usage` — R2の実保存量 / 10GBハード上限 / オブジェクト数
- `/members` — 承認済みメンバー
- `/memories [検索語]` — 長期記憶を確認
- `/remember 内容` — 明示的に長期記憶へ追加
- `/forget ID` — 指定記憶を無効化
- `/persona 内容` — 家族固有のAI指示を設定（admin）
- `/persona reset` — 家族固有指示をリセット（admin）
- `/thinking low|medium|high` — 通常時のThinkingを変更（admin）
- `/deep 質問` — その質問だけhigh Thinking

---

## 11. LINEの送信取消への追従

承認済みユーザーがLINEでメッセージを送信取消した場合、Webhookのunsend eventを受けて次を処理します。

- 生メッセージ本文をD1上で無効化
- 対応するR2メディアを削除
- そのメッセージを根拠にした自動長期記憶を無効化
- そのメッセージを根拠にした要約を削除
- 派生source linkを削除

手動で登録した `/remember` は自動抽出記憶とは別扱いです。

---

## 12. 家庭データを完全削除する

adminが正確に次を送ります。

`/delete-data DELETE ALL`

削除対象:

- D1の会話ログ
- 要約
- 長期記憶
- 記憶・要約の出典リンク
- メンバー設定
- Webhook処理状態
- R2の当該グループ配下メディア
- WorkerとLINEグループのbinding

削除後に再利用する場合は `/setup SETUP_CODE` からやり直します。

---

## 無料枠で使う場合の注意

この構成は無料枠内で開始できますが、各社の無料上限は存在します。

- Gemini Free Tier: レート制限あり
- Cloudflare Workers / D1 / R2 / Queues: Free plan / included usageの上限あり
- LINE: 通常のReplyはPushとは課金・通数の扱いが異なります。Reply tokenの安全時間を超えた場合だけHome AIはPushへフォールバックするため、そのPushはLINE公式アカウント側の月間送信枠を消費します。

R2について、**Storageは10GBのアプリ側ハード上限を実装済み**です。一方、Class A/Bの月次正式値はCloudflareの課金メーターがauthoritativeです。このアプリの通常アクセスは1添付あたり数回程度で、無料枠（A 100万 / B 1000万）に対して家族2人用途では非常に小さい想定です。`/usage` はR2の実オブジェクト容量を表示しますが、Cloudflareアカウント全体の正式なClass A/B請求値を置き換えるものではありません。

記憶処理はLINE返信処理とは別Queue invocationへ分離し、D1の1 invocationあたりquery上限を圧迫しない設計にしています。Queue consumerは家族チャット用途では処理順序・冪等性を優先して `max_concurrency=1` です。

---

## 最終チェックリスト

すべてYESなら利用開始できます。

- [ ] LINE公式アカウントを作成した
- [ ] Messaging APIを有効化した
- [ ] グループトーク参加を許可した
- [ ] Channel ID / Channel secretを取得した
- [ ] Gemini API keyを取得した
- [ ] CloudflareでR2 subscriptionを有効化した（R2 bucket自体は手作成していない）
- [ ] Cloudflareへ `kitworks-iino/line-home-ai` をGit接続した
- [ ] Worker名を `line-home-ai` にした
- [ ] Production branchを `main` にした
- [ ] Cloudflareへ4つのSecretを登録した
- [ ] `/health` が `ready:true` になった
- [ ] LINE Webhook URLを登録してVerifyに成功した
- [ ] 家族専用LINEグループへHome AIを追加した
- [ ] `/setup SETUP_CODE` に成功した
- [ ] 2人目の `/join` → `/approve CODE` に成功した
- [ ] `/status` で登録メンバーが2/2になった
- [ ] `/usage` でR2保存量を確認できた
