import type { Env } from "./types.js";

export interface ModelRoute {
  primary: string;
  fallbacks: string[];
  memory: string;
}

export interface ModelFallbackTransition {
  from: string;
  to: string;
}

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

export function fallbackNotice(exhaustedModels: string[], activeModel: string): string | null {
  if (exhaustedModels.length === 0) return null;
  const chain = [...exhaustedModels, activeModel].map(modelDisplayName).join(" → ");
  return `利用上限（レート制限）に達したため、会話モデルを切り替えます。\n${chain}\n今回は ${modelDisplayName(activeModel)} が対応します！`;
}

export function allModelsExhaustedNotice(models: string[]): string {
  const chain = models.map(modelDisplayName).join(" → ");
  return `会話用モデルの利用上限（レート制限）に達しました。\n試行したモデル: ${chain}\n利用枠が回復してから、もう一度呼びかけてください。`;
}
