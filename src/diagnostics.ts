import type { Env } from "./types.js";
import { GeminiInteractionError, outputText, requestGeminiInteraction } from "./gemini.js";
import { greetingAnswer, routedInstruction, ROUTED_FORMAT } from "./routed-answer.js";
import { conversationModels } from "./model-routing.js";
import { geminiKeyFormat } from "./gemini-key.js";

// One fixed, non-personal smoke test per release. No LINE messages are sent.
export const RELEASE = "1.5.0";
const KEY = `release_check:${RELEASE}`;
type Check = { state: string; primaryModel?: string; greetingMs?: number; greetingModel?: string | null; greeting?: string; searchDiagnostics?: Array<{model:string;status:number;response:string}>; conversationMs?: number; searchMs?: number; checkedAt?: number; conversation?: string; search?: string; status?: number; category?: string; searchPreview?: string; apiMessage?: string; keyFormat?: ReturnType<typeof geminiKeyFormat> };

// Only called for the fixed arithmetic probe: never expose errors for household prompts.
function fixedProbeMessage(error: GeminiInteractionError, key: string): string {
  let message: string;
  try { message=JSON.stringify(JSON.parse(error.raw)); }
  catch { return "non_json_error"; }
  if (key) message=message.split(key).join("[REDACTED]");
  return message.replace(/AIza[\w-]+/g,"[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[URL]").replace(/\b\d{8,}\b/g,"[ID]").slice(0,1500);
}

export async function releaseCheck(env: Env): Promise<Check | null> {
  const existing = await env.DB.prepare("SELECT value FROM app_state WHERE key=?").bind(KEY).first<{value:string}>();
  if (existing) { try { return JSON.parse(existing.value) as Check; } catch { return {state:"invalid"}; } }
  const inserted = await env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING RETURNING key")
    .bind(KEY, JSON.stringify({state:"queued"}), Date.now()).first<{key:string}>();
  if (inserted) {
    try { await env.MEMORY_QUEUE.send({kind:"diagnostic",release:RELEASE},{contentType:"json"}); }
    catch {
      await env.DB.prepare("DELETE FROM app_state WHERE key=? AND value=?").bind(KEY,JSON.stringify({state:"queued"})).run();
      return {state:"queue_unavailable"};
    }
  }
  return {state:"queued"};
}

export async function runReleaseCheck(env: Env, release: string): Promise<void> {
  if (release !== RELEASE) return;
  const claim = await env.DB.prepare("UPDATE app_state SET value=?,updated_at=? WHERE key=? AND value=? RETURNING key")
    .bind(JSON.stringify({state:"running"}),Date.now(),KEY,JSON.stringify({state:"queued"})).first<{key:string}>();
  if (!claim) return;
  let result: Check = {state:"failed",checkedAt:Date.now(),keyFormat:geminiKeyFormat(env)};
  try {
    let phase = Date.now();
    const response = await requestGeminiInteraction(env,conversationModels(env)[0]!,{
      system_instruction:routedInstruction("あなたは日本語で短く答えるアシスタントです。", Date.now()),
      input:"接続テストです。2+2の答えを数字だけで返してください。",
      response_format:ROUTED_FORMAT,
      generation_config:{thinking_level:"low"},
    },20_000,1);
    result.conversationMs = Date.now() - phase;
    const parsed = JSON.parse(outputText(response)) as {search?:boolean;answer?:string};
    if (parsed.search !== false || parsed.answer?.trim() !== "4") throw new Error("unexpected smoke output");
    result.conversation="ok";
    result.primaryModel = conversationModels(env)[0]!;
    phase = Date.now();
    const greeting = await greetingAnswer(env, "あなたは日本語で短く答える家庭向けアシスタントです。", "おい");
    result.greetingMs = Date.now() - phase;
    result.greetingModel = greeting.model;
    result.greeting = greeting.model ? "ok" : "failed";
    // Already verified in 1.4.1: the free 2.5 search models reject this new account.
    // Do not repeat known-failing probes or switch to a paid search tool.
    result.search = "unavailable_legacy_models";
    result.state = "partial";
  } catch (error) {
    result.category = error instanceof GeminiInteractionError ? error.category : "probe_failed";
    if (error instanceof GeminiInteractionError) {
      result.status = error.status;
      if (!result.conversation) result.apiMessage=fixedProbeMessage(error,env.GEMINI_API_KEY);
    }
  }
  result.checkedAt=Date.now();
  await env.DB.prepare("UPDATE app_state SET value=?,updated_at=? WHERE key=?").bind(JSON.stringify(result),Date.now(),KEY).run();
}
