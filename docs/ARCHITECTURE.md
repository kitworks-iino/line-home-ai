# Architecture

## Goal

A private household AI that lives in one LINE group and is usable by exactly two approved family members. The deployment is deliberately single-household: one Worker instance binds to one LINE `groupId` during `/setup` and refuses other groups.

## Runtime flow

1. LINE sends `POST /webhook`.
2. The Worker verifies `x-line-signature` against the **raw request body** with HMAC-SHA256.
3. Verified events are immediately written to Cloudflare Queue and HTTP 200 is returned.
4. A single-concurrency Queue consumer processes events in order.
5. D1 keeps idempotency (`webhookEventId`), membership, messages, summaries and memories.
6. Binary LINE content is copied into an R2 bucket under `groups/{groupId}/messages/{messageId}`.
7. The AI is invoked only on an explicit bot @mention, a natural prefix (`GPT、`, `AI、`, `Home AI ...`), `/deep`, or a quoted reply to a previous AI message.
8. Gemini 3.7 Flash is called through the current Interactions API with `store:false`. Recent conversation, summary segments and active memories are assembled locally.
9. The Worker attempts a LINE Reply while its reply token is fresh. If processing exceeded the safe reply window, it uses Push as a fallback.

## Memory model

Three layers are intentionally separate:

- **Raw messages**: exact approved-member messages and AI replies. An LINE unsend event removes text/media from the source row.
- **Summary segments**: every configured message batch is compressed into a factual conversation summary.
- **Long-term memories**: durable facts, preferences, plans and explicit agreements. Each auto memory records source LINE message IDs.

If a source message is unsent, memories and summaries that derive from it are invalidated/deleted. Manual `/remember` entries have no automatic source and are not affected by unsend.

## Membership and privacy

- First user runs `/setup SETUP_CODE`; that LINE group becomes the only bound group and that user becomes admin.
- Second user runs `/join` and receives a request code.
- Only the admin can approve with `/approve CODE`.
- Unapproved members' ordinary messages are neither persisted nor sent to Gemini.
- The configured household size is two approved members.
- `/delete-data DELETE ALL` deletes D1 household state and every R2 object under that group's prefix, then unbinds the Worker.

## Idempotency

`webhookEventId` is the primary idempotency key and Cloudflare Queue consumer concurrency is one. A generated AI answer is cached in D1 before delivery so a Queue retry never regenerates a different answer. Every event also receives one persistent UUID `push_retry_key`; all Push retries reuse that exact key. Delivery state is tracked separately with `reply_attempted_at` and `delivered_at`.

Queue failures use bounded exponential retry delays and eventually move to the configured dead-letter queue. LINE HTTP 409 for a previously accepted `X-Line-Retry-Key` is treated as successful delivery, as required for idempotent Push retries.

There is one unavoidable distributed-system boundary: LINE and D1 cannot participate in one atomic transaction. A process crash after LINE accepts a message but before D1 records `delivered_at` can make the exact sent LINE message ID unrecoverable. The stable Push retry key prevents a second Push from being accepted, but no implementation can make two independent remote services transactionally atomic.

## Multimodal handling

- LINE binary content is copied to R2 immediately while the source message is available.
- Only media from the local recent-message window is sent to Gemini when the AI is invoked; old unrelated attachments are not resent on every request.
- Small supported image/audio/video/PDF inputs are sent inline. Large supported files use Gemini Files API; the Worker waits until the file becomes `ACTIVE`, then deletes the temporary Gemini file after the interaction.
- Text-like files are decoded and included as text. Unsupported binary MIME types remain stored in R2 and are represented by metadata rather than causing the whole AI request to fail.
