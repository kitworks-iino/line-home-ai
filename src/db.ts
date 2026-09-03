import type { GroupRow, MemberRow, MemoryRow, MessageRow, SummaryRow, ThinkingLevel, Env } from "./types.js";
import { nowMs, randomId } from "./util.js";

export async function getBoundGroup(env: Env): Promise<string | null> {
  return env.DB.prepare("SELECT value FROM app_state WHERE key='bound_group_id'").first<string>("value");
}

export async function bindGroup(env: Env, groupId: string, userId: string, displayName: string, thinking: ThinkingLevel): Promise<boolean> {
  const existing = await getBoundGroup(env);
  if (existing) return existing === groupId;
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('bound_group_id',?,?)").bind(groupId, now),
    env.DB.prepare("INSERT INTO groups(group_id,created_at,thinking_level,memory_cursor_at) VALUES(?,?,?,0)").bind(groupId, now, thinking),
    env.DB.prepare("INSERT INTO members(group_id,user_id,display_name,role,approved_at,active) VALUES(?,?,?,'admin',?,1)").bind(groupId, userId, displayName, now),
  ]);
  return true;
}

export async function getGroup(env: Env, groupId: string): Promise<GroupRow | null> {
  return env.DB.prepare("SELECT group_id,created_at,persona,thinking_level,memory_cursor_at FROM groups WHERE group_id=?").bind(groupId).first<GroupRow>();
}

export async function getMember(env: Env, groupId: string, userId: string): Promise<MemberRow | null> {
  return env.DB.prepare("SELECT group_id,user_id,display_name,role,approved_at,active FROM members WHERE group_id=? AND user_id=? AND active=1").bind(groupId, userId).first<MemberRow>();
}

export async function listMembers(env: Env, groupId: string): Promise<MemberRow[]> {
  const r = await env.DB.prepare("SELECT group_id,user_id,display_name,role,approved_at,active FROM members WHERE group_id=? AND active=1 ORDER BY approved_at").bind(groupId).all<MemberRow>();
  return r.results ?? [];
}

export async function updateMemberName(env: Env, groupId: string, userId: string, displayName: string): Promise<void> {
  await env.DB.prepare("UPDATE members SET display_name=? WHERE group_id=? AND user_id=?").bind(displayName, groupId, userId).run();
}

function joinCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => chars[b % chars.length]!).join("");
}

export async function createJoinRequest(env: Env, groupId: string, userId: string, displayName: string): Promise<string> {
  await env.DB.prepare("UPDATE join_requests SET status='expired' WHERE status='pending' AND expires_at < ?").bind(nowMs()).run();
  const existing = await env.DB.prepare("SELECT code FROM join_requests WHERE group_id=? AND user_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(groupId, userId, nowMs()).first<string>("code");
  if (existing) return existing;
  const code = joinCode();
  const now = nowMs();
  await env.DB.prepare("INSERT INTO join_requests(code,group_id,user_id,display_name,created_at,expires_at,status) VALUES(?,?,?,?,?,?, 'pending')")
    .bind(code, groupId, userId, displayName, now, now + 7 * 24 * 60 * 60 * 1000).run();
  return code;
}

export async function approveJoin(env: Env, groupId: string, code: string): Promise<MemberRow | null> {
  const req = await env.DB.prepare("SELECT user_id,display_name FROM join_requests WHERE code=? AND group_id=? AND status='pending' AND expires_at>?").bind(code.toUpperCase(), groupId, nowMs()).first<{user_id:string;display_name:string}>();
  if (!req) return null;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE group_id=? AND active=1").bind(groupId).first<number>("n") ?? 0;
  if (count >= 2) throw new Error("This deployment is configured for two approved family members.");
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO members(group_id,user_id,display_name,role,approved_at,active) VALUES(?,?,?,'member',?,1) ON CONFLICT(group_id,user_id) DO UPDATE SET display_name=excluded.display_name, role='member', approved_at=excluded.approved_at, active=1").bind(groupId, req.user_id, req.display_name, now),
    env.DB.prepare("UPDATE join_requests SET status='approved' WHERE code=?").bind(code.toUpperCase()),
  ]);
  return getMember(env, groupId, req.user_id);
}

export async function rejectJoin(env: Env, groupId: string, code: string): Promise<boolean> {
  const normalized=code.toUpperCase();
  const exists=await env.DB.prepare("SELECT 1 AS ok FROM join_requests WHERE code=? AND group_id=? AND status='pending'").bind(normalized,groupId).first<number>("ok");
  if(!exists) return false;
  await env.DB.prepare("UPDATE join_requests SET status='rejected' WHERE code=? AND group_id=? AND status='pending'").bind(normalized, groupId).run();
  return true;
}

export interface EventDeliveryState {
  response_text: string | null;
  reply_attempted_at: number | null;
  delivered_at: number | null;
  push_retry_key: string;
}

export async function claimEvent(env: Env, eventId: string, groupId: string | null, eventType: string): Promise<"new"|"retry"|"done"> {
  const row = await env.DB.prepare("SELECT status,attempts,push_retry_key FROM webhook_events WHERE event_id=?").bind(eventId).first<{status:string;attempts:number;push_retry_key:string|null}>();
  const now = nowMs();
  if (row?.status === "completed") return "done";
  if (row) {
    const retryKey = row.push_retry_key ?? crypto.randomUUID();
    await env.DB.prepare("UPDATE webhook_events SET status='processing', attempts=attempts+1, push_retry_key=?, updated_at=? WHERE event_id=?").bind(retryKey, now, eventId).run();
    return "retry";
  }
  await env.DB.prepare("INSERT INTO webhook_events(event_id,group_id,event_type,status,attempts,push_retry_key,updated_at) VALUES(?,?,?,'processing',1,?,?)").bind(eventId, groupId, eventType, crypto.randomUUID(), now).run();
  return "new";
}

export async function eventResponse(env: Env, eventId: string): Promise<EventDeliveryState | null> {
  const row = await env.DB.prepare("SELECT response_text,reply_attempted_at,delivered_at,push_retry_key FROM webhook_events WHERE event_id=?").bind(eventId).first<{response_text:string|null;reply_attempted_at:number|null;delivered_at:number|null;push_retry_key:string|null}>();
  if (!row) return null;
  if (!row.push_retry_key) {
    const key = crypto.randomUUID();
    await env.DB.prepare("UPDATE webhook_events SET push_retry_key=?, updated_at=? WHERE event_id=?").bind(key, nowMs(), eventId).run();
    return {...row, push_retry_key:key};
  }
  return {...row, push_retry_key:row.push_retry_key};
}

export async function cacheEventResponse(env: Env, eventId: string, text: string): Promise<void> {
  await env.DB.prepare("UPDATE webhook_events SET response_text=?, updated_at=? WHERE event_id=?").bind(text, nowMs(), eventId).run();
}

export async function markReplyAttempted(env: Env, eventId: string): Promise<void> {
  const now = nowMs();
  await env.DB.prepare("UPDATE webhook_events SET reply_attempted_at=?, updated_at=? WHERE event_id=?").bind(now, now, eventId).run();
}

export async function markDelivered(env: Env, eventId: string): Promise<void> {
  const now = nowMs();
  await env.DB.prepare("UPDATE webhook_events SET delivered_at=?, updated_at=? WHERE event_id=?").bind(now, now, eventId).run();
}

export async function completeEvent(env: Env, eventId: string): Promise<void> {
  const now = nowMs();
  await env.DB.prepare("UPDATE webhook_events SET status='completed',completed_at=?,updated_at=? WHERE event_id=?").bind(now, now, eventId).run();
}

export async function failEvent(env: Env, eventId: string): Promise<void> {
  await env.DB.prepare("UPDATE webhook_events SET status='failed',updated_at=? WHERE event_id=?").bind(nowMs(), eventId).run();
}

export async function saveUserMessage(env: Env, row: Omit<MessageRow,"id"|"role"|"unsent">): Promise<MessageRow> {
  const id = randomId("msg");
  await env.DB.prepare(`INSERT OR IGNORE INTO messages(id,group_id,line_message_id,webhook_event_id,sender_user_id,sender_name,role,type,text,media_key,mime_type,media_size,quoted_message_id,created_at,unsent)
    VALUES(?,?,?,?,?,?,'user',?,?,?,?,?,?,?,0)`).bind(id,row.group_id,row.line_message_id,row.webhook_event_id,row.sender_user_id,row.sender_name,row.type,row.text,row.media_key,row.mime_type,row.media_size,row.quoted_message_id,row.created_at).run();
  const saved = await env.DB.prepare("SELECT * FROM messages WHERE line_message_id=?").bind(row.line_message_id).first<MessageRow>();
  if (!saved) throw new Error("Failed to persist message");
  return saved;
}

export async function saveAssistantMessage(env: Env, groupId: string, lineMessageId: string, text: string, createdAt: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO messages(id,group_id,line_message_id,webhook_event_id,sender_user_id,sender_name,role,type,text,media_key,mime_type,media_size,quoted_message_id,created_at,unsent)
  VALUES(?,?,?,?,NULL,'Home AI','assistant','text',?,NULL,NULL,NULL,NULL,?,0)`).bind(randomId("msg"),groupId,lineMessageId,null,text,createdAt).run();
}

export async function isAssistantMessage(env: Env, groupId: string, lineMessageId: string): Promise<boolean> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=? AND line_message_id=? AND role='assistant' AND unsent=0").bind(groupId,lineMessageId).first<number>("n") ?? 0;
  return n > 0;
}

export async function getRecentMessages(env: Env, groupId: string, limit: number): Promise<MessageRow[]> {
  const r = await env.DB.prepare("SELECT * FROM messages WHERE group_id=? AND unsent=0 ORDER BY created_at DESC LIMIT ?").bind(groupId,limit).all<MessageRow>();
  return (r.results ?? []).reverse();
}

export async function getMessagesAfter(env: Env, groupId: string, after: number, limit: number): Promise<MessageRow[]> {
  const r = await env.DB.prepare("SELECT * FROM messages WHERE group_id=? AND role='user' AND unsent=0 AND created_at>? ORDER BY created_at ASC LIMIT ?").bind(groupId,after,limit).all<MessageRow>();
  return r.results ?? [];
}

export async function unsendMessage(env: Env, groupId: string, lineMessageId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT media_key FROM messages WHERE group_id=? AND line_message_id=?").bind(groupId,lineMessageId).first<{media_key:string|null}>();
  await env.DB.prepare("UPDATE messages SET unsent=1,text=NULL,media_key=NULL,mime_type=NULL,media_size=NULL WHERE group_id=? AND line_message_id=?").bind(groupId,lineMessageId).run();
  const memoryIds = await env.DB.prepare("SELECT memory_id FROM memory_sources WHERE line_message_id=?").bind(lineMessageId).all<{memory_id:number}>();
  for (const m of memoryIds.results ?? []) await env.DB.prepare("UPDATE memories SET active=0,updated_at=? WHERE id=?").bind(nowMs(),m.memory_id).run();
  const summaryIds = await env.DB.prepare("SELECT summary_id FROM summary_sources WHERE line_message_id=?").bind(lineMessageId).all<{summary_id:number}>();
  for (const s of summaryIds.results ?? []) await env.DB.prepare("DELETE FROM summaries WHERE id=?").bind(s.summary_id).run();
  await env.DB.prepare("DELETE FROM memory_sources WHERE line_message_id=?").bind(lineMessageId).run();
  await env.DB.prepare("DELETE FROM summary_sources WHERE line_message_id=?").bind(lineMessageId).run();
  return row?.media_key ?? null;
}

export async function listMemories(env: Env, groupId: string, query = "", limit = 30): Promise<MemoryRow[]> {
  const pattern = `%${query.replaceAll("%","\\%").replaceAll("_","\\_")}%`;
  const r = await env.DB.prepare("SELECT * FROM memories WHERE group_id=? AND active=1 AND (?='' OR content LIKE ? ESCAPE '\\' OR memory_key LIKE ? ESCAPE '\\') ORDER BY manual DESC,updated_at DESC LIMIT ?").bind(groupId,query,pattern,pattern,limit).all<MemoryRow>();
  return r.results ?? [];
}

export async function upsertMemory(env: Env, groupId: string, subjectKey: string, memoryKey: string, content: string, confidence: number, manual: boolean, sourceIds: string[]): Promise<number> {
  const now = nowMs();
  await env.DB.prepare(`INSERT INTO memories(group_id,subject_key,memory_key,content,confidence,manual,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(group_id,subject_key,memory_key) DO UPDATE SET content=excluded.content,confidence=excluded.confidence,manual=MAX(memories.manual,excluded.manual),active=1,updated_at=excluded.updated_at`)
    .bind(groupId,subjectKey,memoryKey,content,confidence,manual?1:0,now,now).run();
  const id = await env.DB.prepare("SELECT id FROM memories WHERE group_id=? AND subject_key=? AND memory_key=?").bind(groupId,subjectKey,memoryKey).first<number>("id");
  if (id == null) throw new Error("Failed to upsert memory");
  await env.DB.prepare("DELETE FROM memory_sources WHERE memory_id=?").bind(id).run();
  for (const source of sourceIds) await env.DB.prepare("INSERT OR IGNORE INTO memory_sources(memory_id,line_message_id) VALUES(?,?)").bind(id,source).run();
  return id;
}

export async function deactivateMemory(env: Env, groupId: string, id: number): Promise<boolean> {
  const exists=await env.DB.prepare("SELECT 1 AS ok FROM memories WHERE group_id=? AND id=? AND active=1").bind(groupId,id).first<number>("ok");
  if(!exists) return false;
  await env.DB.prepare("UPDATE memories SET active=0,updated_at=? WHERE group_id=? AND id=?").bind(nowMs(),groupId,id).run();
  return true;
}

export async function deactivateMemoryByKey(env: Env, groupId: string, subjectKey: string, memoryKey: string): Promise<void> {
  await env.DB.prepare("UPDATE memories SET active=0,updated_at=? WHERE group_id=? AND subject_key=? AND memory_key=?").bind(nowMs(),groupId,subjectKey,memoryKey).run();
}

export async function addSummary(env: Env, groupId: string, summary: string, sourceIds: string[]): Promise<void> {
  const now = nowMs();
  await env.DB.prepare("INSERT INTO summaries(group_id,summary,created_at) VALUES(?,?,?)").bind(groupId,summary,now).run();
  const id = await env.DB.prepare("SELECT last_insert_rowid() AS id").first<number>("id");
  if (id == null) return;
  for (const source of sourceIds) await env.DB.prepare("INSERT OR IGNORE INTO summary_sources(summary_id,line_message_id) VALUES(?,?)").bind(id,source).run();
}

export async function listSummaries(env: Env, groupId: string, limit = 8): Promise<SummaryRow[]> {
  const r = await env.DB.prepare("SELECT * FROM summaries WHERE group_id=? ORDER BY created_at DESC LIMIT ?").bind(groupId,limit).all<SummaryRow>();
  return (r.results ?? []).reverse();
}

export async function setMemoryCursor(env: Env, groupId: string, at: number): Promise<void> {
  await env.DB.prepare("UPDATE groups SET memory_cursor_at=? WHERE group_id=?").bind(at,groupId).run();
}

export async function setPersona(env: Env, groupId: string, persona: string | null): Promise<void> {
  await env.DB.prepare("UPDATE groups SET persona=? WHERE group_id=?").bind(persona,groupId).run();
}

export async function setThinking(env: Env, groupId: string, level: ThinkingLevel): Promise<void> {
  await env.DB.prepare("UPDATE groups SET thinking_level=? WHERE group_id=?").bind(level,groupId).run();
}

export async function stats(env: Env, groupId: string): Promise<{messages:number;memories:number;summaries:number}> {
  const messages = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=? AND unsent=0").bind(groupId).first<number>("n") ?? 0;
  const memories = await env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE group_id=? AND active=1").bind(groupId).first<number>("n") ?? 0;
  const summaries = await env.DB.prepare("SELECT COUNT(*) AS n FROM summaries WHERE group_id=?").bind(groupId).first<number>("n") ?? 0;
  return {messages,memories,summaries};
}

export async function deleteGroupData(env: Env, groupId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM memories WHERE group_id=?)").bind(groupId),
    env.DB.prepare("DELETE FROM summary_sources WHERE summary_id IN (SELECT id FROM summaries WHERE group_id=?)").bind(groupId),
    env.DB.prepare("DELETE FROM memories WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM summaries WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM messages WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM join_requests WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM members WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM webhook_events WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM groups WHERE group_id=?").bind(groupId),
    env.DB.prepare("DELETE FROM app_state WHERE key='bound_group_id' AND value=?").bind(groupId),
  ]);
}
