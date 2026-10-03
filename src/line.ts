import type { Env } from "./types.js";
import { mediaFileLimitBytes, MediaLimitError, readBoundedMedia } from "./media-store.js";
import { boundedMs, fetchWithTimeout } from "./timeout.js";
import { splitLineText } from "./util.js";

const profileCache = new Map<string, { name: string; expiresAt: number }>();

let tokenCache: { token: string; expiresAt: number } | null = null;

function lineApiTimeoutMs(env: Env): number {
  return boundedMs(env.LINE_API_TIMEOUT_MS, 10_000, 3_000, 30_000);
}

async function lineToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET });
  const res = await fetchWithTimeout(
    "https://api.line.me/oauth2/v3/token",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    lineApiTimeoutMs(env),
    "LINE token API",
  );
  if (!res.ok) throw new Error(`LINE token issue failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
}

async function lineFetch(env: Env, url: string, init: RequestInit = {}, maxResponseBytes?: number): Promise<Response> {
  const execute = async (): Promise<Response> => {
    const token = await lineToken(env);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetchWithTimeout(url, { ...init, headers }, lineApiTimeoutMs(env), "LINE Messaging API", maxResponseBytes);
  };
  let res = await execute();
  if (res.status === 401) {
    tokenCache = null;
    res = await execute();
  }
  return res;
}

export async function getGroupMemberProfile(env: Env, groupId: string, userId: string): Promise<string> {
  const cacheKey = `${env.LINE_CHANNEL_ID}:${groupId}:${userId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const res = await lineFetch(env, `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`);
    if (!res.ok) return `LINE user ${userId.slice(-6)}`;
    const j = await res.json() as { displayName?: string };
    const name = j.displayName?.trim() || `LINE user ${userId.slice(-6)}`;
    if (profileCache.size >= 100) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(cacheKey, { name, expiresAt: Date.now() + 600_000 });
    return name;
  } catch (error) {
    console.warn("LINE profile lookup failed; continuing with fallback display name", error);
    return `LINE user ${userId.slice(-6)}`;
  }
}

export async function getMessageContent(env: Env, messageId: string): Promise<{buffer:ArrayBuffer;contentType:string}> {
  const res = await lineFetch(env, `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {}, mediaFileLimitBytes(env));
  if (res.status === 404 || res.status === 410) throw new MediaLimitError("expired");
  if (!res.ok) throw new Error(`LINE content fetch failed: ${res.status}`);
  const buffer = await readBoundedMedia(res, mediaFileLimitBytes(env));
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
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

// Administrative verification returns booleans/quotas, never tokens or profile identifiers.
export async function checkLineConnection(env: Env): Promise<{bot: boolean; webhook: boolean; freeMessagesRemaining: number | null}> {
  const bot = await lineFetch(env, "https://api.line.me/v2/bot/info");
  if (!bot.ok) throw new Error(`LINE bot authentication failed: ${bot.status}`);
  const hook = await lineFetch(env, "https://api.line.me/v2/bot/channel/webhook/endpoint");
  if (!hook.ok) throw new Error(`LINE webhook lookup failed: ${hook.status}`);
  const endpoint = await hook.json() as { endpoint?: string; active?: boolean };
  const quota = await lineFetch(env, "https://api.line.me/v2/bot/message/quota");
  const consumption = await lineFetch(env, "https://api.line.me/v2/bot/message/quota/consumption");
  let remaining: number | null = null;
  if (quota.ok && consumption.ok) {
    const q = await quota.json() as {type?:string;value?:number};
    const c = await consumption.json() as {totalUsage?:number};
    if (q.type === "limited" && q.value === 200 && typeof c.totalUsage === "number") remaining = Math.max(0, 200 - c.totalUsage);
  }
  return {bot:true, webhook:endpoint.active === true && endpoint.endpoint === "https://line-home-ai.kitworks.workers.dev/webhook", freeMessagesRemaining:remaining};
}
