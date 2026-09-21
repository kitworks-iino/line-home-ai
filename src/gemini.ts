import type { Env, MessageRow, ThinkingLevel } from "./types.js";
import {
  conversationModels,
  loadModelQuotaBlocks,
  memoryModel,
  quotaBlockFrom429,
  saveModelQuotaBlock,
} from "./model-routing.js";
import { boundedMs, fetchWithTimeout, UpstreamTimeoutError } from "./timeout.js";
import { base64FromArrayBuffer, safeJson } from "./util.js";

const INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
const INLINE_MAX = 8 * 1024 * 1024;
const R2_LIMIT_MARKER_MIME = "application/x-line-home-ai-r2-limit";
const TRANSIENT_ATTEMPTS = 2;

export type GeminiInput = {type:"text";text:string} | {type:"image"|"audio"|"video"|"document";mime_type:string;data?:string;uri?:string};
export type RouteFailureReason = "quota" | "timeout" | "upstream";
export interface RouteFailure { model: string; reason: RouteFailureReason }

export interface InteractionResponse {
  id?: string;
  status?: string;
  error?: { message?: string };
  errors?: Array<{ code?: string; message?: string }>;
  steps?: Array<{type:string;content?:Array<{type:string;text?:string}>}>;
}

type GeminiErrorCategory = "authentication" | "permission" | "billing" | "region" | "thinking_unsupported" | "model_unavailable" | "invalid_request" | "quota" | "timeout" | "upstream" | "network" | "incomplete" | "blocked" | "invalid_response";

function apiErrorDetails(raw: string): { code: string; message: string; fields: string[] } {
  try {
    const json = JSON.parse(raw) as {
      error?: { status?: string; code?: string | number; message?: string; details?: Array<{ reason?: string; fieldViolations?: Array<{ field?: string }> }> };
      errors?: Array<{ code?: string; message?: string }>;
    };
    const details = json.error?.details ?? [];
    return {
      code: String(json.error?.status ?? json.errors?.[0]?.code ?? json.error?.code ?? "unknown"),
      message: [json.error?.message, ...details.map((detail) => detail.reason), ...(json.errors ?? []).map((error) => `${error.code ?? ""} ${error.message ?? ""}`)].filter(Boolean).join(" "),
      fields: details.flatMap((detail) => detail.fieldViolations ?? []).map((violation) => violation.field ?? "").filter(Boolean),
    };
  } catch {
    // Non-JSON failures are classified locally but never copied into logs or LINE replies.
    return { code: "unknown", message: raw, fields: [] };
  }
}

function errorCategory(status: number, raw: string): GeminiErrorCategory {
  const detail = apiErrorDetails(raw);
  const message = `${detail.code} ${detail.message} ${detail.fields.join(" ")}`;
  if (status === 401 || /API_KEY_(?:INVALID|EXPIRED)|API key.{0,60}(?:not valid|invalid|expired|leaked)|invalid.{0,20}API key/i.test(message)) return "authentication";
  if (/location.{0,40}not supported|region.{0,40}not supported|unsupported.{0,20}(?:region|location)/i.test(message)) return "region";
  if (status === 402 || /BILLING_DISABLED|billing.{0,50}(?:required|enabled|enable)|enable.{0,20}billing|paid tier|prepay.{0,20}credit/i.test(message)) return "billing";
  if (status === 403) return "permission";
  if (status === 429) return "quota";
  if (status === 408 || status === 524) return "timeout";
  if (/SAFETY|PROHIBITED_CONTENT|BLOCKLIST|CONTENT_BLOCKED/i.test(message)) return "blocked";
  if (/INTERACTION_INCOMPLETE/i.test(message)) return "incomplete";
  if (/INVALID_RESPONSE|EMPTY_OUTPUT/i.test(message)) return "invalid_response";
  if (status >= 500) return "upstream";
  if (status === 400 && /thinking[_ .-]?level|thinking config|thinking_config/i.test(message) && /not supported|unsupported|invalid|unknown|not allowed|only supports/i.test(message)) return "thinking_unsupported";
  if ((status === 400 || status === 404) && /model/i.test(message) && /not found|not supported|unsupported|not available|unavailable|does not exist|deprecated|invalid model/i.test(message)) return "model_unavailable";
  return "invalid_request";
}

export class GeminiInteractionError extends Error {
  readonly category: GeminiErrorCategory;
  #raw: string;
  get raw(): string { return this.#raw; }
  constructor(public readonly status: number, raw: string, public readonly model: string) {
    const category = errorCategory(status, raw);
    super(`Gemini interaction failed: model=${model} status=${status} category=${category}`);
    this.name = "GeminiInteractionError";
    this.category = category;
    this.#raw = raw;
  }
}

export interface GeminiFailureDiagnostic {
  status: number;
  category: GeminiErrorCategory;
  model: string;
  time: number;
}

export async function readLastGeminiError(env: Env): Promise<GeminiFailureDiagnostic | null> {
  const db = (env as Partial<Env>).DB;
  if (!db) return null;
  const row = await db.prepare("SELECT value FROM app_state WHERE key=?").bind("last_gemini_error").first<{ value: string }>();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as GeminiFailureDiagnostic;
    return typeof value.status === "number" && typeof value.category === "string" && typeof value.model === "string" && typeof value.time === "number" ? value : null;
  } catch { return null; }
}

async function logApiFailure(env: Env, error: GeminiInteractionError): Promise<void> {
  const details = apiErrorDetails(error.raw);
  // API messages can echo input text, API keys and file URLs. Log only bounded identifiers.
  const identifier = (value: string): string => /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(value) ? value : "redacted";
  console.warn("gemini_api_failure", JSON.stringify({
    model: error.model, status: error.status, category: error.category,
    apiCode: identifier(details.code), fields: details.fields.slice(0,8).map(identifier),
  }));
  const db = (env as Partial<Env>).DB;
  if (db) {
    const diagnostic: GeminiFailureDiagnostic = { model: error.model, status: error.status, category: error.category, time: Date.now() };
    await db.prepare(`INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind("last_gemini_error", JSON.stringify(diagnostic), diagnostic.time).run()
      .catch(() => console.warn("gemini_diagnostic_persist_failed"));
  }
}

function failureReply(error: GeminiInteractionError): string {
  const diagnostic = `（HTTP ${error.status} / ${error.category}）`;
  if (error.category === "authentication") return `Gemini APIキーが無効・期限切れ・停止状態のため、回答できませんでした。管理者がGoogle AI StudioでAPIキーを確認する必要があります。${diagnostic}`;
  if (error.category === "permission") return `Gemini APIへのアクセスが拒否されました。管理者がAPIキーの制限と対象プロジェクトの権限を確認する必要があります。${diagnostic}`;
  if (error.category === "billing" || error.category === "region") return `現在のGemini APIプロジェクトでは、この機能を無料で利用できません。管理者が利用条件を確認する必要があります。自動で課金設定は変更していません。${diagnostic}`;
  if (error.category === "blocked") return "Geminiがこの内容への回答を生成できませんでした。質問や添付内容を変えて、もう一度呼びかけてください。";
  return `Gemini APIがリクエストを受け付けませんでした。管理者がAPI設定を確認する必要があります。${diagnostic}`;
}

export interface AnswerResult {
  text: string;
  model: string | null;
  exhaustedModels: string[];
  newlyExhaustedModels: string[];
  routeFailures: RouteFailure[];
  newRouteFailures: RouteFailure[];
  allModelsExhausted: boolean;
  terminalReason: "quota" | "deadline" | "upstream" | null;
}

export function outputText(response: InteractionResponse): string {
  const chunks: string[] = [];
  for (const step of response.steps ?? []) {
    if (!step || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) if (block?.type === "text" && typeof block.text === "string" && block.text) chunks.push(block.text);
  }
  return chunks.join("\n").trim();
}

function transientRetryableStatus(status: number): boolean {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

function transientRetryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, Math.max(500, seconds * 1000));
  }
  return attempt === 0 ? 1_500 : 3_000;
}

function modelTimeoutMs(env: Env): number {
  return boundedMs(env.GEMINI_MODEL_TIMEOUT_MS, 45_000, 10_000, 90_000);
}

function replyDeadlineMs(env: Env, thinking: ThinkingLevel): number {
  return thinking === "high"
    ? boundedMs(env.GEMINI_DEEP_DEADLINE_MS, 180_000, 30_000, 300_000)
    : boundedMs(env.GEMINI_REPLY_DEADLINE_MS, 90_000, 20_000, 180_000);
}

function memoryTimeoutMs(env: Env): number {
  return boundedMs(env.GEMINI_MEMORY_TIMEOUT_MS, 45_000, 10_000, 120_000);
}

export async function requestGeminiInteraction(
  env: Env,
  model: string,
  body: Record<string,unknown>,
  timeoutMs: number,
  attempts = TRANSIENT_ATTEMPTS,
): Promise<InteractionResponse> {
  const deadline = Date.now() + timeoutMs;
  let requestBody = body;
  let thinkingRetried = false;
  let transientRetries = 0;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const remaining = deadline - started;
    if (remaining <= 0) throw new UpstreamTimeoutError(`Gemini Interactions ${model}`, timeoutMs);
    console.log(`gemini_request_start model=${model} attempt=${attempt + 1} timeoutMs=${remaining}`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: { res: Response; raw: string };
    try {
      // Keep the deadline active through reading the response body, not just its headers.
      response = await Promise.race([
        fetch(INTERACTIONS, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({ ...requestBody, model, store: false }),
          signal: controller.signal,
        }).then(async (res) => ({ res, raw: await res.text() })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new UpstreamTimeoutError(`Gemini Interactions ${model}`, timeoutMs));
          }, remaining);
        }),
      ]);
    } catch (error) {
      console.warn(`gemini_request_error model=${model} attempt=${attempt + 1} category=${controller.signal.aborted ? "timeout" : "network"} elapsedMs=${Date.now() - started}`);
      if (controller.signal.aborted || error instanceof UpstreamTimeoutError) throw new UpstreamTimeoutError(`Gemini Interactions ${model}`, timeoutMs);
      const networkError = new GeminiInteractionError(503, '{"error":{"status":"UNAVAILABLE","message":"Network request failed"}}', model);
      await logApiFailure(env, networkError);
      throw networkError;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const { res, raw } = response;
    console.log(`gemini_request_end model=${model} attempt=${attempt + 1} status=${res.status} elapsedMs=${Date.now() - started}`);
    if (res.ok) {
      let json: InteractionResponse;
      try { json = JSON.parse(raw) as InteractionResponse; }
      catch {
        const error = new GeminiInteractionError(502, '{"error":{"status":"INVALID_RESPONSE"}}', model);
        await logApiFailure(env, error);
        throw error;
      }
      if (!json || typeof json !== "object") {
        const error = new GeminiInteractionError(502, '{"error":{"status":"INVALID_RESPONSE"}}', model);
        await logApiFailure(env, error);
        throw error;
      }
      if (json.status && json.status !== "completed") {
        const error = new GeminiInteractionError(502, JSON.stringify({ error: { status: `INTERACTION_${json.status.toUpperCase()}` }, errors: json.errors }), model);
        await logApiFailure(env, error);
        throw error;
      }
      if (!Array.isArray(json.steps) || !outputText(json)) {
        const error = new GeminiInteractionError(502, '{"error":{"status":"EMPTY_OUTPUT"}}', model);
        await logApiFailure(env, error);
        throw error;
      }
      return json;
    }

    const error = new GeminiInteractionError(res.status, raw, model);
    await logApiFailure(env, error);
    const config = requestBody.generation_config as Record<string,unknown> | undefined;
    if (error.category === "thinking_unsupported" && !thinkingRetried && config?.thinking_level !== undefined) {
      // Only an explicit parameter rejection triggers this compatibility adjustment.
      const { thinking_level: _thinking, ...rest } = config;
      requestBody = { ...requestBody, generation_config: rest };
      thinkingRetried = true;
      console.warn(`gemini_thinking_compatibility_retry model=${model}`);
      continue;
    }

    if (!transientRetryableStatus(res.status) || transientRetries >= Math.max(1, attempts) - 1) {
      throw error;
    }

    const delay = transientRetryDelayMs(transientRetries++, res.headers.get("retry-after"));
    if (Date.now() + delay >= deadline) throw new UpstreamTimeoutError(`Gemini Interactions ${model}`, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function interaction(env: Env, model: string, body: Record<string,unknown>, timeoutMs: number, attempts = TRANSIENT_ATTEMPTS): Promise<string> {
  return outputText(await requestGeminiInteraction(env, model, body, timeoutMs, attempts));
}

// Content MIME enums: https://ai.google.dev/api/interactions-api
const SUPPORTED_IMAGE_MIMES = new Set(["image/png","image/jpeg","image/webp","image/heic","image/heif","image/gif","image/bmp","image/tiff"]);
const SUPPORTED_AUDIO_MIMES = new Set(["audio/wav","audio/mp3","audio/aiff","audio/aac","audio/ogg","audio/flac","audio/mpeg","audio/m4a","audio/l16","audio/opus","audio/alaw","audio/mulaw","audio/webm"]);
const SUPPORTED_VIDEO_MIMES = new Set(["video/mp4","video/mpeg","video/mpg","video/mov","video/avi","video/x-flv","video/webm","video/wmv","video/3gpp"]);

function normalizedMime(mime: string): string {
  const value = mime.split(";",1)[0]!.trim().toLowerCase();
  const aliases: Record<string,string> = { "image/jpg":"image/jpeg", "audio/x-wav":"audio/wav", "audio/x-m4a":"audio/m4a", "video/quicktime":"video/mov" };
  return aliases[value] ?? value;
}

function mediaType(mime: string): "image"|"audio"|"video"|"document"|null {
  if (SUPPORTED_IMAGE_MIMES.has(mime)) return "image";
  if (SUPPORTED_AUDIO_MIMES.has(mime)) return "audio";
  if (SUPPORTED_VIDEO_MIMES.has(mime)) return "video";
  if (mime === "application/pdf") return "document";
  return null;
}

function isTextLike(mime: string): boolean {
  return mime.startsWith("text/") || ["application/json","application/xml","application/javascript"].includes(mime);
}

interface UploadedFile { name: string; uri: string; mime_type: string }

async function uploadGeminiFile(env: Env, buffer: ArrayBuffer, mimeType: string, displayName: string): Promise<UploadedFile> {
  const timeout = modelTimeoutMs(env);
  const start = await fetchWithTimeout("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(buffer.byteLength),
      "x-goog-upload-header-content-type": mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  }, Math.min(timeout, 20_000), "Gemini file upload init");
  if (!start.ok) throw new Error(`Gemini file upload init failed: ${start.status} ${await start.text()}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload URL missing");
  const finish = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(buffer.byteLength),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
      "content-type": mimeType,
    },
    body: buffer,
  }, Math.min(Math.max(timeout, 30_000), 60_000), "Gemini file upload");
  const text = await finish.text();
  if (!finish.ok) throw new Error(`Gemini file upload failed: ${finish.status} ${text}`);
  const json = safeJson<{file:{name:string;uri:string;mimeType?:string;mime_type?:string;state?:string}}>(text);
  const uploaded = { name: json.file.name, uri: json.file.uri, mime_type: json.file.mimeType ?? json.file.mime_type ?? mimeType };
  await waitForGeminiFileReady(env, uploaded.name);
  return uploaded;
}

async function waitForGeminiFileReady(env: Env, name: string): Promise<void> {
  const deadline = Date.now() + Math.min(60_000, Math.max(30_000, modelTimeoutMs(env)));
  while (Date.now() < deadline) {
    const remaining = Math.max(1_000, deadline - Date.now());
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/${name}`,
      { headers: { "x-goog-api-key": env.GEMINI_API_KEY } },
      Math.min(10_000, remaining),
      "Gemini file status",
    );
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini file status failed: ${res.status} ${raw}`);
    const json = safeJson<{state?:string;error?:{message?:string}}>(raw);
    const state = (json.state ?? "ACTIVE").toUpperCase();
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error(`Gemini file processing failed: ${json.error?.message ?? name}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new UpstreamTimeoutError("Gemini file processing", deadline - (deadline - Math.min(60_000, Math.max(30_000, modelTimeoutMs(env)))));
}

async function deleteGeminiFile(env: Env, name: string): Promise<void> {
  await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/${name}`,
    { method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY } },
    10_000,
    "Gemini file delete",
  );
}

export async function mediaInputs(env: Env, messages: MessageRow[], max: number): Promise<{inputs:GeminiInput[];cleanup:()=>Promise<void>}> {
  const inputs: GeminiInput[] = [];
  const uploaded: UploadedFile[] = [];
  const count = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  if (count === 0) return { inputs, cleanup: async () => {} };
  const media = messages.filter((m) => m.media_key && m.mime_type && !m.unsent).slice(-count);
  for (const m of media) {
    const obj = await env.MEDIA.get(m.media_key!);
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    const mime = normalizedMime(m.mime_type!);
    inputs.push({ type:"text", text:`添付メディア: ${m.sender_name} が送信した ${m.type} (message_id=${m.line_message_id}, mime=${mime})` });
    if (mime === R2_LIMIT_MARKER_MIME) {
      inputs.push({type:"text", text:"この添付はCloudflare R2 Standardの無料ストレージ上限10 GBを超えないため、バイナリ本体を保存していません。内容そのものは参照できません。必要なら /usage で現在のR2保存量を確認してください。"});
      continue;
    }
    if (isTextLike(mime)) {
      const decoded = new TextDecoder().decode(buf);
      const clipped = decoded.length > 200_000 ? `${decoded.slice(0,200_000)}\n[以降省略]` : decoded;
      inputs.push({type:"text", text:`添付テキスト内容:\n${clipped}`});
      continue;
    }
    const type = mediaType(mime);
    if (!type) {
      inputs.push({type:"text", text:"この添付形式はGemini APIの対応外のため、ファイルの存在とメタデータのみ参照します。内容を見た・聞いたとは回答せず、必要なら対応形式での再送を依頼してください。"});
      continue;
    }
    if (buf.byteLength <= INLINE_MAX) inputs.push({ type, mime_type:mime, data:base64FromArrayBuffer(buf) });
    else {
      const f = await uploadGeminiFile(env, buf, mime, m.line_message_id);
      uploaded.push(f);
      inputs.push({ type, mime_type:f.mime_type, uri:f.uri });
    }
  }
  return { inputs, cleanup: async () => { await Promise.all(uploaded.map((f) => deleteGeminiFile(env,f.name).catch(()=>undefined))); } };
}

export async function answer(env: Env, systemInstruction: string, prompt: string, media: GeminiInput[], thinking: ThinkingLevel): Promise<AnswerResult> {
  const models = conversationModels(env);
  const exhaustedModels: string[] = [];
  const newlyExhaustedModels: string[] = [];
  const routeFailures: RouteFailure[] = [];
  const newRouteFailures: RouteFailure[] = [];
  const started = Date.now();
  const deadlineAt = started + replyDeadlineMs(env, thinking);
  const quotaBlocks = await loadModelQuotaBlocks(env, models).catch((error) => {
    console.warn("failed to load Gemini quota blocks; continuing with live probes", error);
    return new Map();
  });

  for (const model of models) {
    if (quotaBlocks.has(model)) {
      exhaustedModels.push(model);
      routeFailures.push({ model, reason: "quota" });
      continue;
    }

    const remaining = deadlineAt - Date.now();
    if (remaining < 1_500) {
      console.warn(`gemini_reply_deadline_reached elapsedMs=${Date.now() - started}`);
      return {
        text: "Gemini APIの応答が遅延しているため、今回の処理は待機上限で打ち切りました。もう一度呼びかけてください。",
        model: null,
        exhaustedModels,
        newlyExhaustedModels,
        routeFailures,
        newRouteFailures,
        allModelsExhausted: false,
        terminalReason: "deadline",
      };
    }

    try {
      const text = await interaction(env, model, {
        system_instruction: systemInstruction,
        input: [{type:"text",text:prompt}, ...media],
        generation_config: { thinking_level: thinking },
      }, Math.min(modelTimeoutMs(env), remaining));
      console.log(`gemini_answer_success model=${model} totalElapsedMs=${Date.now() - started}`);
      return { text, model, exhaustedModels, newlyExhaustedModels, routeFailures, newRouteFailures, allModelsExhausted: false, terminalReason: null };
    } catch (error) {
      if (error instanceof GeminiInteractionError && error.status === 429) {
        const block = quotaBlockFrom429(error.raw);
        await saveModelQuotaBlock(env, model, block).catch((persistError) => {
          console.warn(`failed to persist Gemini quota block model=${model}`, persistError);
        });
        exhaustedModels.push(model);
        newlyExhaustedModels.push(model);
        routeFailures.push({ model, reason: "quota" });
        newRouteFailures.push({ model, reason: "quota" });
        continue;
      }
      if (error instanceof UpstreamTimeoutError) {
        console.warn(`gemini_model_timeout model=${model} elapsedMs=${Date.now() - started}`);
        routeFailures.push({ model, reason: "timeout" });
        newRouteFailures.push({ model, reason: "timeout" });
        continue;
      }
      if (error instanceof GeminiInteractionError && (error.status === 408 || error.status === 524 || error.status >= 500)) {
        if (error.category === "blocked") {
          return { text: failureReply(error), model: null, exhaustedModels, newlyExhaustedModels, routeFailures, newRouteFailures, allModelsExhausted: false, terminalReason: "upstream" };
        }
        console.warn(`gemini_model_upstream_failure model=${model} status=${error.status} elapsedMs=${Date.now() - started}`);
        routeFailures.push({ model, reason: error.status === 524 ? "timeout" : "upstream" });
        newRouteFailures.push({ model, reason: error.status === 524 ? "timeout" : "upstream" });
        continue;
      }
      if (error instanceof GeminiInteractionError && (error.category === "model_unavailable" || error.category === "thinking_unsupported")) {
        routeFailures.push({ model, reason: "upstream" });
        newRouteFailures.push({ model, reason: "upstream" });
        continue;
      }
      if (error instanceof GeminiInteractionError) {
        return {
          text: failureReply(error),
          model: null,
          exhaustedModels,
          newlyExhaustedModels,
          routeFailures,
          newRouteFailures,
          allModelsExhausted: false,
          terminalReason: "upstream",
        };
      }
      throw error;
    }
  }

  const onlyQuota = routeFailures.length > 0 && routeFailures.every((failure) => failure.reason === "quota");
  return {
    text: onlyQuota ? "" : "Gemini API側の遅延または一時障害により、設定済みの会話モデルから時間内に回答を取得できませんでした。もう一度呼びかけてください。",
    model: null,
    exhaustedModels,
    newlyExhaustedModels,
    routeFailures,
    newRouteFailures,
    allModelsExhausted: onlyQuota,
    terminalReason: onlyQuota ? "quota" : "upstream",
  };
}

export interface MemoryExtraction {
  summary: string;
  memories: Array<{ action:"upsert"|"delete"; subject_key:string; memory_key:string; content:string;confidence:number;source_message_ids:string[] }>;
}

const MEMORY_SCHEMA = {
  type:"object",
  additionalProperties:false,
  properties:{
    summary:{type:"string"},
    memories:{type:"array",maxItems:8,items:{type:"object",additionalProperties:false,properties:{
      action:{type:"string",enum:["upsert","delete"]},
      subject_key:{type:"string"},
      memory_key:{type:"string"},
      content:{type:"string"},
      confidence:{type:"number"},
      source_message_ids:{type:"array",maxItems:100,items:{type:"string"}}
    },required:["action","subject_key","memory_key","content","confidence","source_message_ids"]}}
  },required:["summary","memories"]
};

export async function extractMemory(env: Env, prompt: string): Promise<MemoryExtraction | null> {
  const model = memoryModel(env);
  const quotaBlocks = await loadModelQuotaBlocks(env, [model]).catch(() => new Map());
  if (quotaBlocks.has(model)) return null;

  try {
    const text = await interaction(env, model, {
      system_instruction: "あなたは家庭内会話の記憶管理器です。永続価値のある事実・嗜好・予定・合意・人間関係・継続中の課題だけを抽出してください。雑談、推測、一時的感情、センシティブ情報の不必要な推測は記憶しません。既存記憶と矛盾する新情報は同じmemory_keyでupsertしてください。撤回が明示された場合はdelete。変更候補は重要度順に最大8件です。source_message_idsは根拠となる実在IDのみ。subject_keyは家族共通ならfamily、個人なら提示されたuser_idを厳密に使います。",
      input: prompt,
      generation_config: { thinking_level: "low" },
      response_format: { type:"text", mime_type:"application/json", schema: MEMORY_SCHEMA },
    }, memoryTimeoutMs(env), 1);
    return safeJson<MemoryExtraction>(text);
  } catch (error) {
    if (error instanceof GeminiInteractionError && error.status === 429) {
      const block = quotaBlockFrom429(error.raw);
      await saveModelQuotaBlock(env, model, block).catch((persistError) => {
        console.warn(`failed to persist memory-model quota block model=${model}`, persistError);
      });
      console.warn(`memory model quota limited; postponing extraction model=${model} scope=${block.scope}`);
      return null;
    }
    if (error instanceof UpstreamTimeoutError || (error instanceof GeminiInteractionError && (error.status === 408 || error.status === 524 || error.status >= 500))) {
      console.warn(`memory model unavailable; postponing extraction model=${model}`);
      return null;
    }
    if (error instanceof GeminiInteractionError) {
      console.warn(`memory model rejected request; postponing extraction model=${model} category=${error.category} status=${error.status}`);
      return null;
    }
    throw error;
  }
}
