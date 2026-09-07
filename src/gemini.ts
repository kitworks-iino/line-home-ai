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

interface InteractionResponse {
  id?: string;
  status?: string;
  error?: { message?: string };
  steps?: Array<{type:string;content?:Array<{type:string;text?:string}>}>;
}

class GeminiInteractionError extends Error {
  constructor(public readonly status: number, public readonly raw: string, public readonly model: string) {
    super(`Gemini interaction failed: model=${model} status=${status} ${raw}`);
  }
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

function outputText(response: InteractionResponse): string {
  const chunks: string[] = [];
  for (const step of response.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) if (block.type === "text" && block.text) chunks.push(block.text);
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

async function interaction(
  env: Env,
  model: string,
  body: Record<string,unknown>,
  timeoutMs: number,
  attempts = TRANSIENT_ATTEMPTS,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = Date.now();
    console.log(`gemini_request_start model=${model} attempt=${attempt + 1} timeoutMs=${timeoutMs}`);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        INTERACTIONS,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({ model, store: false, ...body }),
        },
        timeoutMs,
        `Gemini Interactions ${model}`,
      );
    } catch (error) {
      console.warn(`gemini_request_error model=${model} attempt=${attempt + 1} elapsedMs=${Date.now() - started}`, error);
      throw error;
    }

    const raw = await res.text();
    console.log(`gemini_request_end model=${model} attempt=${attempt + 1} status=${res.status} elapsedMs=${Date.now() - started}`);
    if (res.ok) {
      const json = safeJson<InteractionResponse>(raw);
      const text = outputText(json);
      if (!text) throw new Error(`Gemini returned no text output (model=${model}, status=${json.status ?? "unknown"})`);
      return text;
    }

    if (res.status === 429 || res.status === 524) throw new GeminiInteractionError(res.status, raw, model);

    if (!transientRetryableStatus(res.status) || attempt === attempts - 1) {
      throw new GeminiInteractionError(res.status, raw, model);
    }

    await new Promise((resolve) => setTimeout(resolve, transientRetryDelayMs(attempt, res.headers.get("retry-after"))));
  }
  throw new Error("Gemini interaction exhausted retries unexpectedly");
}

function mediaType(mime: string): "image"|"audio"|"video"|"document"|null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
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
  const media = messages.filter((m) => m.media_key && m.mime_type && !m.unsent).slice(-max);
  for (const m of media) {
    const obj = await env.MEDIA.get(m.media_key!);
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    const mime = m.mime_type!;
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
      inputs.push({type:"text", text:"このMIMEタイプはGeminiへバイナリ送信せず、ファイルの存在とメタデータのみ参照します。"});
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
        console.warn(`gemini_model_upstream_failure model=${model} status=${error.status} elapsedMs=${Date.now() - started}`);
        routeFailures.push({ model, reason: error.status === 524 ? "timeout" : "upstream" });
        newRouteFailures.push({ model, reason: error.status === 524 ? "timeout" : "upstream" });
        continue;
      }
      if (error instanceof GeminiInteractionError) {
        return {
          text: `Gemini APIへの接続でHTTP ${error.status}エラーが発生したため、回答を生成できませんでした。設定またはAPI状態の確認が必要です。`,
          model,
          exhaustedModels,
          newlyExhaustedModels,
          routeFailures,
          newRouteFailures,
          allModelsExhausted: false,
          terminalReason: "upstream",
        };
      }
      if (error instanceof Error && error.message.startsWith("Gemini returned no text output")) {
        routeFailures.push({ model, reason: "upstream" });
        newRouteFailures.push({ model, reason: "upstream" });
        continue;
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
      console.warn(`memory model unavailable; postponing extraction model=${model}`, error);
      return null;
    }
    throw error;
  }
}
