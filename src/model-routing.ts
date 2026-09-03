import type { Env } from "./types.js";

export interface ModelRoute {
  primary: string;
  fallbacks: string[];
  memory: string;
}

export type QuotaScope = "minute" | "day" | "unknown";

export interface ModelQuotaBlock {
  blockedUntil: number;
  scope: QuotaScope;
}

const QUOTA_KEY_PREFIX = "gemini_quota:";

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models.map((m) => m.trim()).filter(Boolean)) {
    if (seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

export function conversationModels(env: Pick<Env, "GEMINI_MODEL" | "GEMINI_FALLBACK_MODELS">): string[] {
  const primary = env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  const fallbacks = (env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return uniqueModels([primary, ...fallbacks]);
}

export function memoryModel(env: Pick<Env, "GEMINI_MEMORY_MODEL">): string {
  return env.GEMINI_MEMORY_MODEL?.trim() || "gemini-3.5-flash-lite";
}

export function modelRoute(env: Pick<Env, "GEMINI_MODEL" | "GEMINI_FALLBACK_MODELS" | "GEMINI_MEMORY_MODEL">): ModelRoute {
  const models = conversationModels(env);
  return {
    primary: models[0]!,
    fallbacks: models.slice(1),
    memory: memoryModel(env),
  };
}

export function modelDisplayName(model: string): string {
  if (model === "gemini-flash-latest") return "Gemini Flash 最新版";
  const match = model.match(/^gemini-(\d+(?:\.\d+)?)-(flash(?:-lite)?)$/i);
  if (match) {
    const variant = match[2]!.toLowerCase() === "flash-lite" ? "Flash-Lite" : "Flash";
    return `Gemini ${match[1]} ${variant}`;
  }
  return model;
}

export function fallbackNotice(newlyExhaustedModels: string[], activeModel: string): string | null {
  if (newlyExhaustedModels.length === 0) return null;
  const chain = [...newlyExhaustedModels, activeModel].map(modelDisplayName).join(" → ");
  return `利用上限（レート制限）に達したため、会話モデルを切り替えます。\n${chain}\n今回は ${modelDisplayName(activeModel)} が対応します！`;
}

export function allModelsExhaustedNotice(models: string[]): string {
  const chain = models.map(modelDisplayName).join(" → ");
  return `会話用モデルの利用上限（レート制限）に達しました。\n現在利用できないモデル: ${chain}\n利用枠が回復してから、もう一度呼びかけてください。`;
}

function retryDelayMs(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        details?: Array<{ retryDelay?: string }>;
        message?: string;
      };
    };
    for (const detail of parsed.error?.details ?? []) {
      const value = detail.retryDelay;
      if (!value) continue;
      const match = value.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
    const message = parsed.error?.message ?? "";
    const match = message.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (match) return Math.ceil(Number(match[1]) * 1000);
  } catch {
    // Error bodies are not guaranteed to remain JSON. Fall back to conservative windows below.
  }
  return null;
}

function quotaIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        details?: Array<{ violations?: Array<{ quotaId?: string }> }>;
      };
    };
    return (parsed.error?.details ?? [])
      .flatMap((detail) => detail.violations ?? [])
      .map((violation) => violation.quotaId ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function zonedDateParts(timestamp: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function timeZoneOffsetMinutes(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(timestamp));
  const zone = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = zone.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

export function nextPacificQuotaResetMs(now: number): number {
  const timeZone = "America/Los_Angeles";
  const local = zonedDateParts(now, timeZone);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const year = nextDate.getUTCFullYear();
  const month = nextDate.getUTCMonth();
  const day = nextDate.getUTCDate();
  const localMidnightAsUtc = Date.UTC(year, month, day, 0, 0, 0);

  // Start near Pacific midnight, then resolve the actual UTC offset. Re-evaluating once
  // handles PST/PDT correctly for normal and DST-transition dates.
  let candidate = Date.UTC(year, month, day, 8, 0, 0);
  for (let i = 0; i < 2; i++) {
    const offset = timeZoneOffsetMinutes(candidate, timeZone);
    candidate = localMidnightAsUtc - offset * 60_000;
  }
  return candidate;
}

export function quotaBlockFrom429(raw: string, now = Date.now()): ModelQuotaBlock {
  const ids = quotaIds(raw);
  const normalized = `${ids.join(" ")} ${raw}`.toLowerCase();
  const delay = retryDelayMs(raw);
  const isDay = normalized.includes("perday") || normalized.includes("per_day") || normalized.includes("per day");
  const isMinute = normalized.includes("perminute") || normalized.includes("per_minute") || normalized.includes("per minute");

  if (isDay) {
    const reset = nextPacificQuotaResetMs(now) + 2_000;
    return { blockedUntil: Math.max(reset, now + (delay ?? 0) + 1_000), scope: "day" };
  }
  if (isMinute) {
    return { blockedUntil: now + (delay ?? 60_000) + 1_000, scope: "minute" };
  }
  return { blockedUntil: now + (delay ?? 60_000) + 1_000, scope: "unknown" };
}

function quotaKey(model: string): string {
  return `${QUOTA_KEY_PREFIX}${model}`;
}

export async function loadModelQuotaBlocks(env: Env, models: string[], now = Date.now()): Promise<Map<string, ModelQuotaBlock>> {
  const db = (env as Partial<Env>).DB;
  if (!db || models.length === 0) return new Map();
  const keys = models.map(quotaKey);
  const placeholders = keys.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT key,value FROM app_state WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const result = new Map<string, ModelQuotaBlock>();
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.value) as ModelQuotaBlock;
      if (!Number.isFinite(parsed.blockedUntil) || parsed.blockedUntil <= now) continue;
      const model = row.key.slice(QUOTA_KEY_PREFIX.length);
      result.set(model, parsed);
    } catch {
      // Ignore malformed stale state. A successful future call will clear it.
    }
  }
  return result;
}

export async function saveModelQuotaBlock(env: Env, model: string, block: ModelQuotaBlock, now = Date.now()): Promise<void> {
  const db = (env as Partial<Env>).DB;
  if (!db) return;
  await db.prepare(`INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(quotaKey(model), JSON.stringify(block), now)
    .run();
}

export async function clearModelQuotaBlock(env: Env, model: string): Promise<void> {
  const db = (env as Partial<Env>).DB;
  if (!db) return;
  await db.prepare("DELETE FROM app_state WHERE key=?").bind(quotaKey(model)).run();
}
