import { searchEventIntent, calendarDate } from "./events.js";
import type { Env } from "./types.js";
import { GeminiInteractionError, outputText, requestGeminiInteraction } from "./gemini.js";
import { UpstreamTimeoutError } from "./timeout.js";
import { conversationModels } from "./model-routing.js";
import { geminiKeyFormat } from "./gemini-key.js";

// One fixed, non-personal smoke test per release. No LINE messages are sent.
export const RELEASE = "1.6.0";
const KEY = `release_check:${RELEASE}`;
type Probe = { model: string; elapsedMs: number; outcome: string; requestedTier?: string; servedTier?: string; returnedModel?: string };
type Check = { probes?: Probe[]; state: string; primaryModel?: string; greetingMs?: number; greetingModel?: string | null; greeting?: string; searchDiagnostics?: Array<{model:string;status:number;response:string}>; conversationMs?: number; searchMs?: number; checkedAt?: number; conversation?: string; search?: string; status?: number; category?: string; searchPreview?: string; apiMessage?: string; keyFormat?: ReturnType<typeof geminiKeyFormat> };

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
  result.probes = [];
  for (const tier of ["priority", "standard", "standard", "priority"]) {
    const model = conversationModels(env)[0]!;
    const started = Date.now();
    try {
      const response = await requestGeminiInteraction(env,model,{
        service_tier:tier,
        system_instruction:"あなたは日本語で短く答える家庭向けアシスタントです。呼びかけに1文で返答してください。",
        input:"おい",
        generation_config:{thinking_level:"low",max_output_tokens:512},
      },20_000,1);
      if (!outputText(response).trim()) throw new Error("empty output");
      result.probes.push({model,elapsedMs:Date.now()-started,outcome:"ok",requestedTier:tier,...(response.servedTier ? {servedTier:response.servedTier} : {}),...(response.model ? {returnedModel:response.model} : {})});
    } catch (error) {
      const category = error instanceof UpstreamTimeoutError ? "timeout" : error instanceof GeminiInteractionError ? error.category : "probe_failed";
      result.probes.push({model,elapsedMs:Date.now()-started,outcome:category,requestedTier:tier});
      if (error instanceof GeminiInteractionError && ["authentication","permission","billing"].includes(error.category)) {
        result.category=category;result.status=error.status;
        result.apiMessage=fixedProbeMessage(error,env.GEMINI_API_KEY);
        break;
      }
    }
  }
  result.primaryModel=conversationModels(env)[0]!;
  result.conversation=result.probes[0]?.outcome ?? "failed";
  result.state=result.probes.some(p=>p.outcome==="ok") ? "partial" : "failed";
  if (result.probes.some(p=>p.outcome==="ok")) {
    const date=calendarDate(Date.now());
    const start=Date.now();
    const search=await searchEventIntent(env,{search:true,start_date:date,end_date:date,location:"静岡県浜松市",public_keywords:[]},Date.now()+40_000,(model,status,raw)=>{
      result.searchDiagnostics=[{model,status,response:raw.slice(0,3000)}];
    });
    result.searchMs=Date.now()-start;
    result.search=search.includes("参照リンク") ? "ok" : "unavailable";
    if (result.search === "ok") result.state="ok";
  }
  result.checkedAt=Date.now();
  await env.DB.prepare("UPDATE app_state SET value=?,updated_at=? WHERE key=?").bind(JSON.stringify(result),Date.now(),KEY).run();
}
