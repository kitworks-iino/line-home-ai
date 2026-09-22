import type { Env, ThinkingLevel } from "./types.js";
import { answer, type AnswerResult, type GeminiInput } from "./gemini.js";
import { eventIntentInstruction, INTENT_SCHEMA, normalizeEventIntent, searchEventIntent } from "./events.js";

export const ROUTED_FORMAT = {
  type: "text", mime_type: "application/json",
  schema: {
    ...INTENT_SCHEMA,
    properties: { ...INTENT_SCHEMA.properties, answer: { type: "string" } },
    required: [...INTENT_SCHEMA.required, "answer"],
  },
};

// Exact standalone greetings only; ambiguous follow-ups still use full reasoning.
export function isSimpleGreeting(text: string): boolean {
  return /^(?:おい|ねえ|ねぇ|こんにちは|こんばんは|おはよう|ありがとう|やあ|もしもし)[\s!！?？。]*$/u
    .test(text.replace(/^\s*@?HOME[-_ ]AI\s*/iu, "").trim());
}

export function routedInstruction(system: string, now: number): string {
  return `${system}\n\n${eventIntentInstruction(now).replace("回答せず、", "")}\n\n` +
    "出力形式の最終規則: 検索判断と通常回答を一度の生成で行います。search=falseならanswerに利用者への通常の回答本文を入れ、日付・場所は空文字、public_keywordsは空配列にしてください。" +
    "search=trueならanswerは空文字にし、検索条件のみ出力してください。アプリが実際に検索して結果を返信します。検索前にイベントを創作して答えないでください。" +
    "単なる呼びかけには短く自然に応答し、過去のイベント相談を勝手に再開しないでください。JSON以外は出力しないでください。";
}

export async function routedAnswer(env: Env, system: string, prompt: string, media: GeminiInput[], thinking: ThinkingLevel, now: number, observeSearch?: (model: string, status: number, raw: string) => void): Promise<AnswerResult> {
  const result = await answer(env, routedInstruction(system, now), prompt, media, thinking, ROUTED_FORMAT);
  if (!result.model) return result;
  try {
    const value: unknown = JSON.parse(result.text);
    if (!value || typeof value !== "object" || typeof (value as { search?: unknown }).search !== "boolean") throw new Error("invalid route");
    const intent = normalizeEventIntent(value);
    if (intent) return { ...result, text: await searchEventIntent(env, intent, Date.now() + 45_000, observeSearch) };
    const text = (value as { answer?: unknown }).answer;
    if (typeof text !== "string" || !text.trim()) throw new Error("empty answer");
    return { ...result, text: text.trim() };
  } catch {
    return { ...result, text: "回答の形式を正しく読み取れませんでした。もう一度聞いてください。" };
  }
}
