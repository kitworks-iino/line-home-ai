import type { Env } from "./types.js";
import { canStoreWithinR2Limit, r2HardLimitBytes, r2StorageUsage } from "./r2-guard.js";
import { splitLineText } from "./util.js";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function lineToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET });
  const res = await fetch("https://api.line.me/oauth2/v3/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`LINE token issue failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
}

async function lineFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const execute = async (): Promise<Response> => {
    const token = await lineToken(env);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
  let res = await execute();
  if (res.status === 401) {
    tokenCache = null;
    res = await execute();
  }
  return res;
}

export async function getGroupMemberProfile(env: Env, groupId: string, userId: string): Promise<string> {
  const res = await lineFetch(env, `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`);
  if (!res.ok) return `LINE user ${userId.slice(-6)}`;
  const j = await res.json() as { displayName?: string };
  return j.displayName?.trim() || `LINE user ${userId.slice(-6)}`;
}

export async function getMessageContent(env: Env, messageId: string): Promise<{buffer:ArrayBuffer;contentType:string}> {
  const res = await lineFetch(env, `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`);
  if (!res.ok) throw new Error(`LINE content fetch failed: ${res.status} ${await res.text()}`);
  const buffer = await res.arrayBuffer();
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";

  const usage = await r2StorageUsage(env);
  const limit = r2HardLimitBytes(env);
  if (!canStoreWithinR2Limit(usage.bytes, buffer.byteLength, limit)) {
    return { buffer: new ArrayBuffer(0), contentType: "application/x-line-home-ai-r2-limit" };
  }

  return { buffer, contentType };
}

export interface SentMessage { id: string; quoteToken?: string }

async function send(url: string, env: Env, body: unknown, retryKey?: string): Promise<{ok:boolean;status:number;sent:SentMessage[];text:string}> {
  const headers: Record<string,string> = { "content-type": "application/json" };
  if (retryKey) headers["x-line-retry-key"] = retryKey;
  const res = await lineFetch(env, url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let sent: SentMessage[] = [];
  if (text) {
    try { sent = (JSON.parse(text) as {sentMessages?:SentMessage[]}).sentMessages ?? []; } catch { /* no-op */ }
  }
  return { ok: res.ok || res.status === 409, status: res.status, sent, text };
}

export function lineTextParts(texts: string[]): string[] {
  const parts: string[] = [];
  for (const text of texts) {
    for (const part of splitLineText(text)) {
      if (parts.length >= 5) return parts;
      parts.push(part);
    }
  }
  return parts;
}

export async function replyTexts(env: Env, replyToken: string, texts: string[]): Promise<{ok:boolean;status:number;sent:SentMessage[];text:string}> {
  const messages = lineTextParts(texts).map((text) => ({ type: "text", text }));
  return send("https://api.line.me/v2/bot/message/reply", env, { replyToken, messages });
}

export async function pushTexts(env: Env, groupId: string, texts: string[], retryKey: string): Promise<{ok:boolean;status:number;sent:SentMessage[];text:string}> {
  const messages = lineTextParts(texts).map((text) => ({ type: "text", text }));
  return send("https://api.line.me/v2/bot/message/push", env, { to: groupId, messages }, retryKey);
}

export async function replyText(env: Env, replyToken: string, text: string): Promise<{ok:boolean;status:number;sent:SentMessage[];text:string}> {
  return replyTexts(env, replyToken, [text]);
}

export async function pushText(env: Env, groupId: string, text: string, retryKey: string): Promise<{ok:boolean;status:number;sent:SentMessage[];text:string}> {
  return pushTexts(env, groupId, [text], retryKey);
}

export async function sendBestEffortTexts(env: Env, groupId: string, replyToken: string | undefined, eventTimestamp: number, texts: string[], retryKey: string): Promise<SentMessage[]> {
  const age = Date.now() - eventTimestamp;
  if (replyToken && age < 50_000) {
    const r = await replyTexts(env, replyToken, texts);
    if (r.ok) return r.sent;
    if (r.status !== 400) throw new Error(`LINE reply failed: ${r.status} ${r.text}`);
  }
  const p = await pushTexts(env, groupId, texts, retryKey);
  if (!p.ok) throw new Error(`LINE push failed: ${p.status} ${p.text}`);
  return p.sent;
}

export async function sendBestEffort(env: Env, groupId: string, replyToken: string | undefined, eventTimestamp: number, text: string, retryKey: string): Promise<SentMessage[]> {
  return sendBestEffortTexts(env, groupId, replyToken, eventTimestamp, [text], retryKey);
}
