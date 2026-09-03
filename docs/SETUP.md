# Setup — UI-only steps

After the repository is deployed, no source-code edits or CLI commands are required. The remaining work is account/UI configuration.

## 1. Create the LINE Official Account / Messaging API channel

1. Create a LINE Official Account in LINE Official Account Manager. Naming it **Home AI** matches the examples in this repository, but the code does not depend on the visible account name.
2. Enable Messaging API for that account and open its channel in LINE Developers Console.
3. In the channel settings, record:
   - **Channel ID**
   - **Channel secret**
4. In LINE Official Account Manager, allow the account to participate in group chats.
5. Disable the default automatic reply/greeting behavior if you do not want LINE's stock auto-replies mixed with Home AI.

Do **not** issue or paste a long-lived Messaging API access token. This Worker derives a 15-minute stateless channel access token automatically from Channel ID + Channel secret.

## 2. Get a Gemini API key

1. Open Google AI Studio.
2. Create/select a Gemini API project and create an API key.
3. Keep the key for the Cloudflare secret `GEMINI_API_KEY`.

The code uses model `gemini-3.7-flash` by default and the current Interactions API with `store:false`.

As of September 2026, Google lists Gemini 3.7 Flash Standard API input and output as **free of charge on the Free Tier**. Google also states that Free Tier content may be used to improve its products. Use a paid tier instead if that data-use condition is unacceptable for your household conversations. Free-tier rate limits still apply.

## 3. Prepare Cloudflare Queues

In Cloudflare Dashboard → **Workers & Pages → Queues** create these two queues exactly:

- `line-home-ai-events`
- `line-home-ai-dead-letter`

D1 and R2 are declared as draft bindings in `wrangler.jsonc`; current Wrangler automatic resource provisioning creates and binds them on deployment. If Cloudflare's UI asks you to confirm resource creation, accept it.

## 4. Import this GitHub repository into Cloudflare Workers

1. Cloudflare Dashboard → **Workers & Pages** → create/import from Git.
2. Select `kitworks-iino/line-home-ai`.
3. Production branch: `main`.
4. Deploy command: `npx wrangler deploy` (the default Wrangler deploy is also fine if Cloudflare detects it).
5. Deploy.

The Worker should become available at a URL like:

`https://line-home-ai.<your-workers-subdomain>.workers.dev`

Open `/health`. Before secrets are entered it should return `"ok": true` and `"ready": false`; after all four secrets are entered, `"ready"` must become `true`. The endpoint exposes only booleans for secret presence, never secret values.

## 5. Add Worker Secrets

Cloudflare Worker → **Settings → Variables and Secrets**. Add these as **Secret** values:

- `LINE_CHANNEL_ID` — LINE Developers Channel ID
- `LINE_CHANNEL_SECRET` — LINE Developers Channel secret
- `GEMINI_API_KEY` — Google AI Studio API key
- `SETUP_CODE` — choose a long random private value (recommend 24+ random characters)

The following non-secret defaults are already in `wrangler.jsonc` and normally need no UI change:

- `GEMINI_MODEL=gemini-3.7-flash`
- `DEFAULT_THINKING_LEVEL=medium`
- `MEMORY_BATCH_SIZE=24`
- `RECENT_MESSAGE_LIMIT=40`
- `MAX_MEDIA_CONTEXT=3`

After setting secrets, deploy/restart if Cloudflare asks.

## 6. Connect the LINE webhook

In LINE Developers Console → Messaging API settings:

1. Webhook URL: `https://<your-worker>/webhook`
2. Enable **Use webhook**.
3. Click **Verify**. The Worker intentionally accepts LINE's verification request with an empty `events` array.

## 7. Add Home AI to the family LINE group

1. Add the LINE Official Account to the intended family group.
2. The future admin sends:

`/setup YOUR_SETUP_CODE`

3. Home AI confirms the one-time group binding.
4. The second family member sends:

`/join`

5. Home AI returns an approval code. The admin sends:

`/approve CODE`

At this point the system is fully active for the two approved members.

## 8. Normal usage

Wake it explicitly with any of these:

- LINE's actual `@Home AI` mention
- `GPT、旅行どうする？`
- `AI: この会話を整理して`
- quote/reply to the AI's previous LINE message
- `/deep 難しい質問` to force `high` thinking for one request

Messages between the two approved members are retained as context even when the AI is not called. The bot does not answer those ordinary messages.

## 9. Operational checks

Useful commands:

- `/status`
- `/members`
- `/memories`
- `/remember ...`
- `/forget ID`
- `/persona ...`
- `/thinking low|medium|high`
- `/help`

To erase the household data from both D1 and R2:

`/delete-data DELETE ALL`

This also removes the group binding, so `/setup` is required before reuse.

## Free-tier and privacy notes

- Gemini 3.7 Flash currently has a Free Tier, but its rate limits apply and Google states that Free Tier content may be used to improve its products.
- Cloudflare Free-plan limits also apply. In particular, D1 now fails queries after its daily free row-read/write limits are exceeded until the quota resets, and Queues includes a finite daily operation allowance.
- Normal fast responses use LINE's Reply API. If Gemini/Queue processing exceeds the safe reply-token window, Home AI falls back to LINE Push so the response is not silently lost. Push messages are subject to the LINE Official Account plan's monthly message allowance.

The application never silently upgrades any provider to a paid tier; billing behavior is controlled by the provider accounts you configure in their UIs.
