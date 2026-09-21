import type { Env } from "./types.js";

export function geminiApiKey(env: Pick<Env,"GEMINI_API_KEY">): string {
  let value=(env.GEMINI_API_KEY ?? "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1).trim();
  return value;
}

export function geminiKeyFormat(env: Pick<Env,"GEMINI_API_KEY">): { normalized: boolean; looksLikeGoogleApiKey: boolean } {
  const key=geminiApiKey(env);
  return {normalized:key!==env.GEMINI_API_KEY,looksLikeGoogleApiKey:/^AIza[\w-]{35}$/.test(key)};
}
