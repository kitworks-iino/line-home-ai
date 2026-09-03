import type { Env, LineMessage, LineQueuePayload, LineTextMessage, MessageRow, QueuePayload, ThinkingLevel } from "./types.js";
import { ensureSchema } from "./schema.js";
import {
  bindGroup,
  cacheEventResponse,
  claimEvent,
  completeEvent,
  deleteGroupData,
  eventResponse,
  failEvent,
  getBoundGroup,
  getGroup,
  getMember,
  isAssistantMessage,
  listMembers,
  listMemories,
  listSummaries,
  markDelivered,
  markReplyAttempted,
  saveAssistantMessage,
  saveUserMessage,
  unsendMessage,
  updateMemberName,
  upsertMemory,
} from "./db.js";
import { runCommand } from "./commands.js";
import { conversationPrompt, memoryExtractionPrompt, systemInstruction } from "./context.js";
import { answer, extractMemory, mediaInputs } from "./gemini.js";
import { getGroupMemberProfile, getMessageContent, sendBestEffort } from "./line.js";
import {
  asInt,
  hasNaturalInvocation,
  hasSelfMention,
  normalizeThinking,
  parseCommand,
  splitLineText,
  stripNaturalInvocation,
} from "./util.js";

function eventId(payload: LineQueuePayload): string {
  const e = payload.event;
  if (e.webhookEventId) return e.webhookEventId;
  const source = e.source.groupId ?? e.source.roomId ?? e.source.userId ?? "unknown";
  const message = e.message?.id ?? e.unsend?.messageId ?? "none";
  return `fallback:${source}:${e.type}:${e.timestamp}:${message}`;
}

function groupIdOf(payload: LineQueuePayload): string | null {
  return payload.event.source.type === "group" ? payload.event.source.groupId ?? null : null;
}

function textMessage(message: LineMessage | undefined): message is LineTextMessage {
  return Boolean(message && message.type === "text" && "text" in message);
}

function quotedMessageId(message: LineMessage | undefined): string | null {
  return message && "quotedMessageId" in message ? message.quotedMessageId ?? null : null;
}

function capLineResponse(text: string): string {
  const max = 22_000;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40).trimEnd()}\n\n[LINEの送信上限に合わせて末尾を省略しました]`;
}

async function removeGroupMedia(env: Env, groupId: string): Promise<void> {
  const prefix = `groups/${groupId}/`;
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list(cursor ? { prefix, cursor, limit: 1000 } : { prefix, limit: 1000 });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deliver(
  env: Env,
  eventKey: string,
  groupId: string,
  replyToken: string | undefined,
  timestamp: number,
  text: string,
  persistAssistant: boolean,
): Promise<void> {
  const response = capLineResponse(text);
  let state = await eventResponse(env, eventKey);
  if (!state) throw new Error("Webhook delivery state disappeared");
  if (!state.response_text) {
    await cacheEventResponse(env, eventKey, response);
    state = await eventResponse(env, eventKey);
    if (!state) throw new Error("Webhook delivery state disappeared after response cache");
  }
  if (state.delivered_at) return;

  const responseText = state.response_text ?? response;
  const token = state.reply_attempted_at ? undefined : replyToken;
  await markReplyAttempted(env, eventKey);
  const sent = await sendBestEffort(env, groupId, token, timestamp, responseText, state.push_retry_key);

  if (persistAssistant && sent.length) {
    const parts = splitLineText(responseText);
    for (let i = 0; i < sent.length; i++) {
      const id = sent[i]?.id;
      if (!id) continue;
      await saveAssistantMessage(env, groupId, id, parts[i] ?? responseText, Date.now() + i);
    }
  }
  await markDelivered(env, eventKey);
}

async function persistIncoming(
  env: Env,
  groupId: string,
  eventKey: string,
  userId: string,
  displayName: string,
  message: LineMessage,
  timestamp: number,
  textOverride?: string,
): Promise<MessageRow> {
  let text: string | null = textOverride ?? null;
  let mediaKey: string | null = null;
  let mimeType: string | null = null;
  let mediaSize: number | null = null;

  if (message.type === "text" && "text" in message) {
    text = textOverride ?? message.text;
  } else if (message.type === "location" && "latitude" in message) {
    const title = message.title?.trim() || "位置情報";
    const address = message.address?.trim() ? ` ${message.address.trim()}` : "";
    text = `${title}:${address} (${message.latitude}, ${message.longitude})`;
  } else if (message.type === "sticker" && "stickerId" in message) {
    const keywords = message.keywords?.length ? ` keywords=${message.keywords.join(",")}` : "";
    text = `[スタンプ package=${message.packageId} sticker=${message.stickerId}${keywords}]`;
  } else if (["image", "video", "audio", "file"].includes(message.type)) {
    const content = await getMessageContent(env, message.id);
    mediaKey = `groups/${groupId}/media/${message.id}`;
    mimeType = content.contentType;
    mediaSize = content.buffer.byteLength;
    const metadata: Record<string, string> = {
      groupId,
      lineMessageId: message.id,
      senderUserId: userId,
      senderName: displayName,
      messageType: message.type,
    };
    if ("fileName" in message && message.fileName) metadata.fileName = message.fileName;
    await env.MEDIA.put(mediaKey, content.buffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: metadata,
    });
    if (message.type === "file" && "fileName" in message && message.fileName) text = `[ファイル: ${message.fileName}]`;
  } else {
    text = `[${message.type}]`;
  }

  return saveUserMessage(env, {
    group_id: groupId,
    line_message_id: message.id,
    webhook_event_id: eventKey,
    sender_user_id: userId,
    sender_name: displayName,
    type: message.type,
    text,
    media_key: mediaKey,
    mime_type: mimeType,
    media_size: mediaSize,
    quoted_message_id: quotedMessageId(message),
    created_at: timestamp,
  });
}

async function enqueueMemoryMaintenance(env: Env, groupId: string): Promise<void> {
  await env.EVENT_QUEUE.send({ kind: "memory", groupId, requestedAt: Date.now() }, { contentType: "json" });
}

async function maintainMemory(env: Env, groupId: string): Promise<void> {
  const batchSize = asInt(env.MEMORY_BATCH_SIZE, 24, 4, 100);
  const cursor = await env.DB.prepare(
    "SELECT memory_cursor_at,memory_cursor_message_id FROM groups WHERE group_id=?",
  ).bind(groupId).first<{ memory_cursor_at: number; memory_cursor_message_id: string }>();
  if (!cursor) return;

  const rows = await env.DB.prepare(`SELECT * FROM messages
    WHERE group_id=? AND role='user' AND unsent=0
      AND (created_at>? OR (created_at=? AND line_message_id>?))
    ORDER BY created_at ASC,line_message_id ASC LIMIT ?`)
    .bind(groupId, cursor.memory_cursor_at, cursor.memory_cursor_at, cursor.memory_cursor_message_id, batchSize)
    .all<MessageRow>();
  const messages = rows.results ?? [];
  if (messages.length < batchSize) return;

  const members = await listMembers(env, groupId);
  const existing = await listMemories(env, groupId, "", 120);
  const extracted = await extractMemory(env, memoryExtractionPrompt(messages, existing, members));
  const sourceSet = new Set(messages.map((m) => m.line_message_id));
  const allSources = [...sourceSet];
  const last = messages[messages.length - 1]!;
  const statements: D1PreparedStatement[] = [];

  if (extracted.summary.trim()) {
    statements.push(env.DB.prepare("INSERT INTO summaries(group_id,summary,created_at) VALUES(?,?,?)")
      .bind(groupId, extracted.summary.trim(), Date.now()));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO summary_sources(summary_id,line_message_id)
      SELECT (SELECT id FROM summaries WHERE group_id=? ORDER BY id DESC LIMIT 1), CAST(value AS TEXT)
      FROM json_each(?)`).bind(groupId, JSON.stringify(allSources)));
  }

  for (const memory of extracted.memories.slice(0, 8)) {
    const validSources = [...new Set(memory.source_message_ids.filter((id) => sourceSet.has(id)))];
    const subject = memory.subject_key.trim();
    const key = memory.memory_key.trim();
    if (!subject || !key || validSources.length === 0) continue;
    if (memory.action === "delete") {
      statements.push(env.DB.prepare("UPDATE memories SET active=0,updated_at=? WHERE group_id=? AND subject_key=? AND memory_key=? AND manual=0")
        .bind(Date.now(), groupId, subject, key));
      continue;
    }
    const content = memory.content.trim();
    if (!content || !Number.isFinite(memory.confidence) || memory.confidence < 0.6) continue;
    const now = Date.now();
    statements.push(env.DB.prepare(`INSERT INTO memories(group_id,subject_key,memory_key,content,confidence,manual,active,created_at,updated_at)
      VALUES(?,?,?,?,?,0,1,?,?)
      ON CONFLICT(group_id,subject_key,memory_key) DO UPDATE SET
        content=CASE WHEN memories.manual=1 THEN memories.content ELSE excluded.content END,
        confidence=CASE WHEN memories.manual=1 THEN memories.confidence ELSE excluded.confidence END,
        active=1,updated_at=excluded.updated_at`)
      .bind(groupId, subject, key, content, Math.max(0, Math.min(1, memory.confidence)), now, now));
    statements.push(env.DB.prepare(`DELETE FROM memory_sources WHERE memory_id IN
      (SELECT id FROM memories WHERE group_id=? AND subject_key=? AND memory_key=? AND manual=0)`)
      .bind(groupId, subject, key));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO memory_sources(memory_id,line_message_id)
      SELECT m.id, CAST(j.value AS TEXT)
      FROM memories AS m, json_each(?) AS j
      WHERE m.group_id=? AND m.subject_key=? AND m.memory_key=? AND m.manual=0`)
      .bind(JSON.stringify(validSources), groupId, subject, key));
  }

  statements.push(env.DB.prepare("UPDATE groups SET memory_cursor_at=?,memory_cursor_message_id=? WHERE group_id=?")
    .bind(last.created_at, last.line_message_id, groupId));
  await env.DB.batch(statements);
}

async function handleDeleteAll(env: Env, eventKey: string, groupId: string, payload: LineQueuePayload, text: string): Promise<void> {
  const state = await eventResponse(env, eventKey);
  if (!state?.delivered_at) {
    await deliver(env, eventKey, groupId, payload.event.replyToken, payload.event.timestamp, text, false);
  }
  await removeGroupMedia(env, groupId);
  await deleteGroupData(env, groupId);
}

async function handleCommand(
  env: Env,
  payload: LineQueuePayload,
  eventKey: string,
  groupId: string,
  userId: string,
  displayName: string,
  command: { name: string; args: string },
): Promise<{ deepPrompt?: string; handled: boolean }> {
  const cached = await eventResponse(env, eventKey);
  if (cached?.response_text) {
    await deliver(env, eventKey, groupId, payload.event.replyToken, payload.event.timestamp, cached.response_text, false);
    await completeEvent(env, eventKey);
    return { handled: true };
  }

  const bound = await getBoundGroup(env);
  if (command.name === "setup") {
    let text: string;
    if (bound && bound !== groupId) {
      text = "このHome AIはすでに別のLINEグループへバインドされています。";
    } else if (bound === groupId) {
      text = "このグループはセットアップ済みです。";
    } else if (!command.args || command.args !== env.SETUP_CODE) {
      text = "セットアップコードが一致しません。Cloudflare Secret の SETUP_CODE を確認してください。";
    } else {
      const thinking = normalizeThinking(env.DEFAULT_THINKING_LEVEL, "medium");
      const ok = await bindGroup(env, groupId, userId, displayName, thinking);
      text = ok
        ? `${displayName} を管理者としてHome AIをこのグループに登録しました。\n2人目は /join を送り、その後この管理者が /approve CODE で承認してください。`
        : "セットアップに失敗しました。";
    }
    await deliver(env, eventKey, groupId, payload.event.replyToken, payload.event.timestamp, text, false);
    await completeEvent(env, eventKey);
    return { handled: true };
  }

  if (!bound || bound !== groupId) {
    await completeEvent(env, eventKey);
    return { handled: true };
  }

  const group = await getGroup(env, groupId);
  const member = await getMember(env, groupId, userId);
  if (command.name === "remember" && member) {
    const content = command.args.trim();
    const text = content
      ? `記憶しました。[${await upsertMemory(env, groupId, "family", `manual.${eventKey}`, content, 1, true, [])}] ${content}`
      : "使い方: /remember 覚えておいてほしい内容";
    await deliver(env, eventKey, groupId, payload.event.replyToken, payload.event.timestamp, text, false);
    await completeEvent(env, eventKey);
    return { handled: true };
  }

  const result = await runCommand({ env, groupId, userId, displayName, member, group }, command.name, command.args);
  if (result.deepPrompt) return { handled: false, deepPrompt: result.deepPrompt };
  if (result.deleteAll) {
    await handleDeleteAll(env, eventKey, groupId, payload, result.text);
    return { handled: true };
  }
  await deliver(env, eventKey, groupId, payload.event.replyToken, payload.event.timestamp, result.text, false);
  await completeEvent(env, eventKey);
  return { handled: true };
}

async function processLinePayload(env: Env, payload: LineQueuePayload): Promise<void> {
  const event = payload.event;
  const groupId = groupIdOf(payload);
  const key = eventId(payload);
  const claimed = await claimEvent(env, key, groupId, event.type);
  if (claimed === "done") return;

  try {
    if (event.mode === "standby" || !groupId) {
      await completeEvent(env, key);
      return;
    }

    const bound = await getBoundGroup(env);
    if (bound && bound !== groupId) {
      await completeEvent(env, key);
      return;
    }

    if (event.type === "unsend" && event.unsend?.messageId) {
      if (bound === groupId) {
        const mediaKey = await unsendMessage(env, groupId, event.unsend.messageId);
        if (mediaKey) await env.MEDIA.delete(mediaKey);
      }
      await completeEvent(env, key);
      return;
    }

    if (event.type !== "message" || !event.message || !event.source.userId) {
      await completeEvent(env, key);
      return;
    }

    const userId = event.source.userId;
    const displayName = await getGroupMemberProfile(env, groupId, userId);
    const command = textMessage(event.message) ? parseCommand(event.message.text) : null;
    if (command) {
      const outcome = await handleCommand(env, payload, key, groupId, userId, displayName, command);
      if (outcome.handled) return;
    }

    const group = await getGroup(env, groupId);
    const member = await getMember(env, groupId, userId);
    if (!group || !member) {
      await completeEvent(env, key);
      return;
    }
    if (member.display_name !== displayName) await updateMemberName(env, groupId, userId, displayName);

    const deepPrompt = command?.name === "deep" ? command.args.trim() : undefined;
    const saved = await persistIncoming(env, groupId, key, userId, displayName, event.message, event.timestamp, deepPrompt);

    let invoked = Boolean(deepPrompt);
    if (textMessage(event.message)) invoked ||= hasSelfMention(event.message) || hasNaturalInvocation(event.message.text);
    const quoted = quotedMessageId(event.message);
    if (!invoked && quoted) invoked = await isAssistantMessage(env, groupId, quoted);

    if (!invoked) {
      await enqueueMemoryMaintenance(env, groupId);
      await completeEvent(env, key);
      return;
    }

    let state = await eventResponse(env, key);
    if (!state?.response_text) {
      const recentLimit = asInt(env.RECENT_MESSAGE_LIMIT, 40, 8, 100);
      const recentResult = await env.DB.prepare("SELECT * FROM messages WHERE group_id=? AND unsent=0 ORDER BY created_at DESC,line_message_id DESC LIMIT ?")
        .bind(groupId, recentLimit).all<MessageRow>();
      const recent = (recentResult.results ?? []).reverse();
      const summaries = await listSummaries(env, groupId, 8);
      const memories = await listMemories(env, groupId, "", 80);
      const members = await listMembers(env, groupId);
      const promptBase = conversationPrompt(recent, summaries, memories, saved.line_message_id);
      const cleaned = deepPrompt ?? (textMessage(event.message) ? stripNaturalInvocation(event.message.text) : "");
      const prompt = cleaned && cleaned !== event.message.type
        ? `${promptBase}\n\n【現在の依頼本文】\n${cleaned}`
        : promptBase;
      const maxMedia = asInt(env.MAX_MEDIA_CONTEXT, 3, 0, 8);
      const media = await mediaInputs(env, recent, maxMedia);
      try {
        const thinking: ThinkingLevel = deepPrompt ? "high" : group.thinking_level;
        const generated = await answer(env, systemInstruction(group, members), prompt, media.inputs, thinking);
        await cacheEventResponse(env, key, capLineResponse(generated));
      } finally {
        await media.cleanup();
      }
      state = await eventResponse(env, key);
    }

    if (!state?.response_text) throw new Error("AI response was not cached");
    await deliver(env, key, groupId, event.replyToken, event.timestamp, state.response_text, true);
    await enqueueMemoryMaintenance(env, groupId);
    await completeEvent(env, key);
  } catch (error) {
    await failEvent(env, key).catch(() => undefined);
    throw error;
  }
}

export async function processQueuePayload(env: Env, payload: QueuePayload): Promise<void> {
  await ensureSchema(env);
  if (payload.kind === "memory") {
    await maintainMemory(env, payload.groupId);
    return;
  }
  await processLinePayload(env, payload);
}
