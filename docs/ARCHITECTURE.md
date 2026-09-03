# Architecture

## Goal

A private household AI that lives in one LINE group and is usable by exactly two approved family members. The deployment is deliberately single-household: one Worker instance binds to one LINE `groupId` during `/setup` and refuses other groups.

## Runtime flow

1. LINE sends `POST /webhook`.
2. The Worker verifies `x-line-signature` against the **raw request body** with HMAC-SHA256.
3. Verified events are immediately written to Cloudflare Queue and HTTP 200 is returned.
4. A single-concurrency Queue consumer processes jobs in order.
5. LINE-event jobs handle authorization, persistence, AI invocation and delivery. Memory-maintenance jobs run as separate Queue invocations so long-term-memory work does not consume the LINE reply path's D1 query budget or latency budget.
6. D1 keeps idempotency (`webhookEventId`), membership, messages, summaries and memories.
7. Binary LINE content is copied into R2 under `groups/{groupId}/media/{messageId}`.
8. The AI is invoked only on an explicit bot @mention, a natural prefix (`GPT、`, `AI、`, `Home AI ...`), `/deep`, or a quoted reply to a previous AI message.
9. Gemini 3.7 Flash is called through the current Interactions API with `store:false`. Recent conversation, summary segments and active memories are assembled locally.
10. The Worker attempts a LINE Reply while its reply token is fresh. If processing exceeded the safe reply window, it uses Push as a fallback.

## Memory model

Three layers are intentionally separate:

- **Raw messages**: approved-member messages and AI replies. A LINE unsend event nulls source text/media metadata and deletes the corresponding R2 object.
- **Summary segments**: configured batches of approved-user messages are compressed into factual conversation summaries by a separate memory Queue job.
- **Long-term memories**: durable facts, preferences, plans and explicit agreements. Automatic memories retain source LINE message IDs and extraction is capped to a bounded number of changes per batch.

The memory cursor is the pair `(created_at, line_message_id)`, so multiple messages arriving in the same millisecond are not skipped.

If a source message is unsent, memories and summaries that derive from it are invalidated/deleted together with their source links. Manual `/remember` entries have no automatic source and are not overwritten by automatic memory extraction.

## Membership and privacy

- First user runs `/setup SETUP_CODE`; that LINE group becomes the only bound group and that user becomes admin.
- Second user runs `/join` and receives a request code.
- Only the admin can approve with `/approve CODE`.
- Unapproved members' ordinary messages are neither persisted nor sent to Gemini.
- The configured household size is two approved members.
- `/delete-data DELETE ALL` deletes D1 household state and every R2 object under that group's prefix, then unbinds the Worker.

Application-level approval does **not** hide bot messages from other humans who are physically present in the LINE group. The intended deployment is therefore a dedicated LINE group containing only the two household members and the Home AI official account.

## Idempotency

`webhookEventId` is the primary idempotency key and Cloudflare Queue consumer concurrency is one. A generated AI answer is cached in D1 before delivery so a Queue retry never regenerates a different answer. Every event also receives one persistent UUID `push_retry_key`; all Push retries reuse that exact key. Delivery state is tracked separately with `reply_attempted_at` and `delivered_at`.

Queue failures use bounded exponential retry delays and eventually move to the configured dead-letter queue. LINE HTTP 409 for a previously accepted `X-Line-Retry-Key` is treated as successful delivery, preserving idempotent Push retries.

There is one unavoidable distributed-system boundary: LINE and D1 cannot participate in one atomic transaction. A process crash after LINE accepts a message but before D1 records `delivered_at` can make the exact sent LINE message ID unrecoverable. The stable Push retry key prevents a second Push from being accepted, but no implementation can make two independent remote services transactionally atomic.

## Cloudflare Free-plan query discipline

D1 Free has a per-Worker-invocation query ceiling. Memory extraction therefore runs in its own Queue invocation, source-message links are inserted set-wise through SQLite `json_each()`, and the memory extractor is capped to a bounded set of changes. This prevents message delivery and memory maintenance from competing for the same invocation's query budget.

## Multimodal handling

- LINE binary content is copied to R2 while the source content is still retrievable.
- Only media from the local recent-message window is sent to Gemini when the AI is invoked; old unrelated attachments are not resent on every request.
- Small supported image/audio/video/PDF inputs are sent inline. Large supported files use Gemini Files API; the Worker waits until the file becomes `ACTIVE`, then deletes the temporary Gemini file after the interaction.
- Text-like files are decoded and included as text. Unsupported binary MIME types remain stored in R2 and are represented by metadata rather than causing the whole AI request to fail.
