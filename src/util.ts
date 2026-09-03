import type { LineTextMessage, ThinkingLevel } from "./types.js";

export const utf8 = new TextEncoder();

export function nowMs(): number { return Date.now(); }

export function asInt(value: string | undefined, fallback: number, min = 1, max = 1000): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeThinking(value: string | undefined, fallback: ThinkingLevel = "medium"): ThinkingLevel {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

export function randomId(prefix = "id"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function safeJson<T>(text: string): T {
  try { return JSON.parse(text) as T; }
  catch { throw new Error("Invalid JSON response from upstream service"); }
}

export function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(binary);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = utf8.encode(a);
  const bb = utf8.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}

export function hasSelfMention(message: LineTextMessage): boolean {
  return message.mention?.mentionees.some((m) => m.type === "user" && m.isSelf === true) ?? false;
}

const INVOCATION = /^\s*(?:gpt|ＧＰＴ|ai|ＡＩ|home\s*ai|ホーム\s*ai)(?=$|[\s、,，。.!！?？:：])/iu;

export function hasNaturalInvocation(text: string): boolean {
  return INVOCATION.test(text);
}

export function stripNaturalInvocation(text: string): string {
  return text.replace(INVOCATION, "").replace(/^\s*[、,，:：]\s*/, "").trim();
}

export interface ParsedCommand { name: string; args: string }
export function parseCommand(text: string): ParsedCommand | null {
  const m = text.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() };
}

export function splitLineText(text: string, max = 4500): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < Math.floor(max * 0.6)) cut = remaining.lastIndexOf("。", max);
    if (cut < Math.floor(max * 0.6)) cut = max;
    else cut += 1;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts.slice(0, 5);
}

export function redactSecret(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}
