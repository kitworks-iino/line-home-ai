# Architecture

## Goal

A private household AI that lives in one LINE group and is usable by exactly two approved family members. The deployment is deliberately single-household: one Worker instance binds to one LINE `groupId` during `/setup` and refuses other groups.

## Runtime flow

1. LINE sends `POST /webhook`.
2. The Worker verifies `x-line-signature` against the **raw request body** with HMAC-SHA256.
3. Verified LINE events are immediately written to the dedicated reply Queue (`line-home-ai-events`) and HTTP 200 is returned.
4. The reply Queue consumer runs with `max_concurrency=1` to preserve household conversation ordering.
5. LINE-event jobs handle authorization, persistence, AI invocation and delivery. Long-term-memory maintenance is sent to a physically separate Queue (`line-home-ai-memory`) so a slow memory extraction cannot occupy the reply consumer.
6. D1 keeps idempotency (`webhookEventId`), membership, messages, summaries, memories and persistent Gemini quota blocks.
7. Binary LINE content is copied into R2 under `groups/{groupId}/media/{messageId}`.
8. The AI is invoked only on an explicit bot @mention, a natural prefix (`GPT、`, `AI、`, `Home AI ...`), `/deep`, or a quoted reply to a previous AI message.
9. Normal conversation uses the configured Gemini Flash routing chain through the Interactions API with `store:false`. The primary is `gemini-flash-latest`; quota exhaustion, a model timeout, HTTP 524, or a transient upstream failure can move the request to the next configured model.
10. Long-term-memory extraction uses a separate configured model (`GEMINI_MEMORY_MODEL`) and does not consume the primary conversation model's quota. A memory-model quota/timeout/transient outage postpones extraction without advancing the memory cursor.
11. The Worker attempts a LINE Reply while its reply token is fresh. If processing exceeded the safe reply window, it uses Push as a fallback. When a conversation fallback succeeds, the LINE response contains a model-switch notice first, followed by the requested answer from the lower model.

## Bounded latency

Home AI does not trust upstream APIs to return promptly. Every important network wait now has an application-level bound.

Default production values:

- One Gemini conversation-model attempt: **45 seconds** maximum.
- Normal conversation generation: **90 seconds overall** across the whole model ladder.
- `/deep`: **180 seconds overall**.
- Memory-model call: **45 seconds** maximum.
- LINE Messaging API call: **10 seconds** maximum.

These values are Cloudflare variables rather than response-logic constants and can be tuned without redesigning routing.

A model that exceeds its per-model deadline is abandoned and the next configured conversation model is attempted while time remains. HTTP 524 is treated as a timeout-like upstream failure rather than allowing the request path to sit indefinitely. The entire normal conversation path stops once the 90-second overall generation deadline is reached and returns a visible error instead of remaining silent.

Cloudflare Queue consumers themselves allow much longer wall time, so these application-level bounds are intentional: platform maximums are not used as user-facing latency targets.

## Conversation model routing

Conversation routing is configuration-driven rather than tied to one numbered Gemini release.

- Primary: `GEMINI_MODEL=gemini-flash-latest`
- Fallback ladder: `GEMINI_FALLBACK_MODELS`
- Memory extraction: `GEMINI_MEMORY_MODEL`

Google's `latest` alias can move to a newer Flash release without a Home AI code change. A 429 is treated as quota/rate-limit exhaustion for that route: the same model is not immediately retried because that can multiply RPM/RPD consumption. Instead, the next configured model is attempted. Persistent quota blocks prevent repeatedly probing a known-exhausted model.

Timeouts and transient 5xx errors are not persisted as quota exhaustion. They can still cause a one-request fallback so Home AI can recover through another configured model. The switch notice tells the LINE group whether the upper route failed because of quota, timeout or a temporary API failure.

## Memory model

Three layers are intentionally separate:

- **Raw messages**: approved-member messages and AI replies. A LINE unsend event nulls source text/media metadata and deletes the corresponding R2 object.
- **Summary segments**: configured batches of approved-user messages are compressed into factual conversation summaries by a memory Queue job.
- **Long-term memories**: durable facts, preferences, plans and explicit agreements. Automatic memories retain source LINE message IDs and extraction is capped to a bounded number of changes per batch.

The memory cursor is the pair `(created_at, line_message_id)`, so multiple messages arriving in the same millisecond are not skipped.

Memory extraction uses `GEMINI_MEMORY_MODEL` independently from the normal conversation route. If that model is quota-limited, times out or has a transient upstream failure, the memory cursor is not advanced: the raw conversation remains available and a later successful maintenance pass can catch up.

If a source message is unsent, memories and summaries that derive from it are invalidated/deleted together with their source links. Manual `/remember` entries have no automatic source and are not overwritten by automatic memory extraction.

## Queue isolation and migration

`line-home-ai-events` is reserved for LINE events. `line-home-ai-memory` is reserved for memory maintenance. Both consumers can run independently, so memory latency no longer blocks a later family message.

Deployments created before this split may still have old `kind=memory` messages sitting in `line-home-ai-events`. The consumer detects those legacy jobs, immediately forwards them into `line-home-ai-memory`, acknowledges the old item and continues. This prevents an old memory backlog from preserving the very blockage the split is intended to remove.

## Membership and privacy

- First user runs `/setup SETUP_CODE`; that LINE group becomes the only bound group and that user becomes admin.
- Second user runs `/join` and receives a request code.
- Only the admin can approve with `/approve CODE`.
- Unapproved members' ordinary messages are neither persisted nor sent to Gemini.
- The configured household size is two approved members.
- `/delete-data DELETE ALL` deletes D1 household state and every R2 object under that group's prefix, then unbinds the Worker.

Application-level approval does **not** hide bot messages from other humans who are physically present in the LINE group. The intended deployment is therefore a dedicated LINE group containing only the two household members and the Home AI official account.

## Idempotency

`webhookEventId` is the primary idempotency key and reply Queue consumer concurrency is one. A generated AI answer is cached in D1 before delivery so a Queue retry never regenerates a different answer. Fallback notice + answer are cached together as one delivery state, preserving their order across retries. Every event also receives one persistent UUID `push_retry_key`; all Push retries reuse that exact key. Delivery state is tracked separately with `reply_attempted_at` and `delivered_at`.

Queue failures use bounded exponential retry delays and eventually move to their configured dead-letter queues. LINE HTTP 409 for a previously accepted `X-Line-Retry-Key` is treated as successful delivery, preserving idempotent Push retries.

There is one unavoidable distributed-system boundary: LINE and D1 cannot participate in one atomic transaction. A process crash after LINE accepts a message but before D1 records `delivered_at` can make the exact sent LINE message ID unrecoverable. The stable Push retry key prevents a second Push from being accepted, but no implementation can make two independent remote services transactionally atomic.

## Observability

The Worker logs explicit stage timings for Queue start/completion, LINE-event age, Gemini request start/end, model timeout/fallback, memory jobs and LINE delivery. This allows a future delay to be classified as Queue backlog, Gemini latency, LINE API latency or application failure without inferring from a screenshot alone.

`GET /health` exposes the active model route, queue isolation and configured latency bounds without exposing secrets.

## Cloudflare Free-plan query discipline

D1 Free has a per-Worker-invocation query ceiling. Memory extraction runs in its own Queue invocation, source-message links are inserted set-wise through SQLite `json_each()`, and the memory extractor is capped to a bounded set of changes. Reply processing and memory processing now also use separate Queue consumers, so they do not compete for the same consumer slot.

## Multimodal handling

- LINE binary content is copied to R2 while the source content is still retrievable.
- Only media from the local recent-message window is sent to Gemini when the AI is invoked; old unrelated attachments are not resent on every request.
- Small supported image/audio/video/PDF inputs are sent inline. Large supported files use Gemini Files API; upload/status calls also have bounded network waits, and temporary Gemini files are deleted after the interaction.
- Text-like files are decoded and included as text. Unsupported binary MIME types remain stored in R2 and are represented by metadata rather than causing the whole AI request to fail.
