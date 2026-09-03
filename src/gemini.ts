import type { Env, MessageRow, ThinkingLevel } from "./types.js";
import { base64FromArrayBuffer, safeJson } from "./util.js";

const INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
const INLINE_MAX = 8 * 1024 * 1024;
const R2_LIMIT_MARKER_MIME = "application/x-line-home-ai-r2-limit";

export type GeminiInput = {type:"text";text:string} | {type:"image"|"audio"|"video"|"document";mime_type:string;data?:string;uri?:string};

interface InteractionResponse {
  id?: string;
  status?: string;
  error?: { message?: string };
  steps?: Array<{type:string;content?:Array<{type:string;text?:string}>}>;
}

function outputText(response: InteractionResponse): string {
  const chunks: string[] = [];
  for (const step of response.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) if (block.type === "text" && block.text) chunks.push(block.text);
  }
  return chunks.join("\n").trim();
}

async function interaction(env: Env, body: Record<string,unknown>): Promise<string> {
  const res = await fetch(INTERACTIONS, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ model: env.GEMINI_MODEL || "gemini-3.7-flash", store: false, ...body }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini interaction failed: ${res.status} ${raw}`);
  const json = safeJson<InteractionResponse>(raw);
  const text = outputText(json);
  if (!text) throw new Error(`Gemini returned no text output (status=${json.status ?? "unknown"})`);
  return text;
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
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
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
  });
  if (!start.ok) throw new Error(`Gemini file upload init failed: ${start.status} ${await start.text()}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload URL missing");
  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(buffer.byteLength),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
      "content-type": mimeType,
    },
    body: buffer,
  });
  const text = await finish.text();
  if (!finish.ok) throw new Error(`Gemini file upload failed: ${finish.status} ${text}`);
  const json = safeJson<{file:{name:string;uri:string;mimeType?:string;mime_type?:string;state?:string}}>(text);
  const uploaded = { name: json.file.name, uri: json.file.uri, mime_type: json.file.mimeType ?? json.file.mime_type ?? mimeType };
  await waitForGeminiFileReady(env, uploaded.name);
  return uploaded;
}

async function waitForGeminiFileReady(env: Env, name: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini file status failed: ${res.status} ${raw}`);
    const json = safeJson<{state?:string;error?:{message?:string}}>(raw);
    const state = (json.state ?? "ACTIVE").toUpperCase();
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error(`Gemini file processing failed: ${json.error?.message ?? name}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Gemini file processing timed out: ${name}`);
}

async function deleteGeminiFile(env: Env, name: string): Promise<void> {
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
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

export async function answer(env: Env, systemInstruction: string, prompt: string, media: GeminiInput[], thinking: ThinkingLevel): Promise<string> {
  return interaction(env, {
    system_instruction: systemInstruction,
    input: [{type:"text",text:prompt}, ...media],
    generation_config: { thinking_level: thinking },
  });
}

export interface MemoryExtraction {
  summary: string;
  memories: Array<{ action:"upsert"|"delete"; subject_key:string; memory_key:string; content:string; confidence:number; source_message_ids:string[] }>;
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

export async function extractMemory(env: Env, prompt: string): Promise<MemoryExtraction> {
  const text = await interaction(env, {
    system_instruction: "あなたは家庭内会話の記憶管理器です。永続価値のある事実・嗜好・予定・合意・人間関係・継続中の課題だけを抽出してください。雑談、推測、一時的感情、センシティブ情報の不必要な推測は記憶しません。既存記憶と矛盾する新情報は同じmemory_keyでupsertしてください。撤回が明示された場合はdelete。変更候補は重要度順に最大8件です。source_message_idsは根拠となる実在IDのみ。subject_keyは家族共通ならfamily、個人なら提示されたuser_idを厳密に使います。",
    input: prompt,
    generation_config: { thinking_level: "low" },
    response_format: { type:"text", mime_type:"application/json", schema: MEMORY_SCHEMA },
  });
  return safeJson<MemoryExtraction>(text);
}
