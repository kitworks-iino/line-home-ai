# line-home-ai

A production-oriented **LINE family group AI** for two approved household members, using:

- LINE Messaging API
- Cloudflare Workers + Queues
- Cloudflare D1
- Cloudflare R2
- Gemini Flash latest + quota fallback routing

The repository is designed so that after Git deployment, the human setup is **UI configuration only**: create/enable the LINE Messaging API account, obtain the Gemini API key, import this repository into Cloudflare, enter four secrets, and register the LINE webhook. D1, R2, the processing Queue and the dead-letter Queue are declared in `wrangler.jsonc` and are automatically provisioned/bound by current Wrangler/Cloudflare deployment behavior.

## What it does

- Lives in one dedicated LINE family group.
- Distinguishes the two approved people by LINE `userId`.
- Stores approved-member ordinary conversation as context without interrupting it.
- Replies only when explicitly called (`@Home AI`, `GPT、`, `AI、`), `/deep`, or when you quote/reply to an AI message.
- Supports LINE text, location, sticker metadata, images, audio, video and files.
- Stores binary media in R2 and includes recent relevant media in Gemini multimodal context.
- Keeps R2 binary storage at or below the full **10 GB Standard free-storage boundary** (`10,000,000,000` bytes) instead of using an arbitrary safety margin; `/usage` shows actual R2 object bytes.
- Separates raw chat history, summaries and long-term memory.
- Runs memory maintenance as separate Queue jobs so it does not consume the LINE reply path's D1 query/latency budget.
- Uses a dedicated memory model (`GEMINI_MEMORY_MODEL`) so long-term-memory extraction does not spend the primary conversation model's quota.
- Uses `gemini-flash-latest` as the primary conversation alias, so Google's latest Flash release is adopted automatically when the alias is hot-swapped.
- On HTTP 429, does **not** retry the same exhausted model. It moves through the configured `GEMINI_FALLBACK_MODELS` ladder. When fallback succeeds, LINE first sends a model-switch notice and then the original answer from the lower model.
- Invalidates derived memory and summaries when the originating LINE message is unsent.
- Provides explicit memory/persona/thinking/admin/data-deletion commands.
- Uses HMAC-SHA256 webhook signature verification and a one-time single-group bind.
- Uses short-lived stateless LINE access tokens automatically; no long-lived access token secret is required.
- Uses Gemini Interactions API with `store:false`.
- Uses Queue + `webhookEventId` idempotency, persistent LINE Push retry keys, explicit delivery state, bounded retries and a dead-letter queue.

The intended deployment is a **dedicated group containing only the two household members and Home AI**. Application-level approval prevents unapproved users' ordinary messages from being stored or sent to Gemini, but it cannot hide bot replies from other humans who are physically present in the LINE group.

## Gemini model routing

Current defaults are configured in `wrangler.jsonc`, not hard-coded into the response logic:

```text
Conversation primary: gemini-flash-latest
Fallbacks: gemini-3.7-flash → gemini-3.6-flash → gemini-3.5-flash → gemini-3.5-flash-lite → gemini-3.1-flash-lite
Long-term memory: gemini-3.5-flash-lite
```

A 429 from one conversation model causes one attempt on the next model; the exhausted model is not repeatedly retried. Transient 408/5xx failures still receive bounded retry handling.

## Start here

**[UI-only production setup guide / UIだけで行う本番セットアップ](docs/SETUP.md)**

Design details: **[Architecture](docs/ARCHITECTURE.md)**

R2 billing/free-tier behavior: **[R2 Free Tier](docs/R2_FREE_TIER.md)**

## Required Cloudflare secrets

`LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`, `SETUP_CODE`

## Health endpoint

`GET /health` — returns `ready:true` only when all four required secrets are present and includes the configured primary/fallback/memory model route.

## Webhook endpoint

`POST /webhook`

## Quality checks

```bash
npm install --no-audit --no-fund
npm run check
```

`npm run check` performs strict TypeScript checking, automated contract/unit tests, and a Wrangler deployment dry-run. CI runs the same command on every push/PR.