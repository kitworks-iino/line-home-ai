# line-home-ai

A production-oriented **LINE family group AI** for two approved household members, using:

- LINE Messaging API
- Cloudflare Workers + Queues
- Cloudflare D1
- Cloudflare R2
- Gemini 3.7 Flash

The repository is designed so that after code deployment, the human setup is **UI configuration only**: LINE channel values, Gemini API key, Cloudflare secrets/queues, and webhook registration.

## What it does

- Lives in one LINE family group.
- Distinguishes the two approved people by LINE `userId`.
- Remembers ordinary conversation without interrupting it.
- Replies only when explicitly called (`@Home AI`, `GPT、`, `AI、`), `/deep`, or when you quote/reply to an AI message.
- Supports LINE text, location, sticker metadata, images, audio, video and files.
- Stores binary media in R2 and includes recent relevant media in Gemini multimodal context.
- Separates raw chat history, summaries and long-term memory.
- Invalidates derived memory when the originating LINE message is unsent.
- Provides explicit memory/persona/thinking/admin/data-deletion commands.
- Uses HMAC-SHA256 webhook signature verification and a one-time single-group bind.
- Uses short-lived stateless LINE access tokens automatically; no long-lived access token secret is required.
- Uses Gemini Interactions API with `store:false`.
- Uses Queue + `webhookEventId` idempotency, persistent LINE Push retry keys, explicit delivery state, bounded retries and a dead-letter queue.

## Start here

**[UI-only setup guide](docs/SETUP.md)**

Design details: **[Architecture](docs/ARCHITECTURE.md)**

## Required Cloudflare secrets

`LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`, `SETUP_CODE`

## Health endpoint

`GET /health` — returns `ready:true` only when all four required secrets are present.

## Webhook endpoint

`POST /webhook`

## Quality checks

```bash
npm install --no-audit --no-fund
npm run check
```

CI runs strict TypeScript checking and automated tests on every push/PR.
