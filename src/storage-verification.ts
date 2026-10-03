import type { Env, MessageRow } from "./types.js";
import { mediaStore, mediaDigest, MEDIA_CHUNK_BYTES, MediaLimitError } from "./media-store.js";
import { answer, mediaInputs } from "./gemini.js";
import { checkLineConnection, pushText } from "./line.js";
import { getBoundGroup } from "./db.js";

export const STORAGE_RELEASE = "1.7.0";
const PREFIX = "storage_verification:";

// Only an authenticated Cloudflare Queue producer can request this job. No HTTP admin route.
// Fixed synthetic data; no household content goes into the model or verification report.
export async function runStorageVerification(env: Env, release: string, runId: string, notify: boolean): Promise<void> {
  if (release !== STORAGE_RELEASE || !/^[a-zA-Z0-9_-]{1,48}$/.test(runId)) return;
  const key = `${PREFIX}${release}:${runId}`;
  const claimed = await env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING RETURNING key")
    .bind(key, JSON.stringify({state:"running"}), Date.now()).first<{key:string}>();
  if (!claimed) return;
  const result: Record<string, unknown> = {state:"failed",release,checkedAt:Date.now(),r2BindingAbsent:!("MEDIA" in env)};
  const group = `__verification_${runId}`;
  const store = mediaStore(env);
  const counts = async () => (await env.DB.prepare("SELECT (SELECT COUNT(*) FROM messages) AS messages,(SELECT COUNT(*) FROM members) AS members,(SELECT COUNT(*) FROM groups) AS groups,(SELECT COUNT(*) FROM memories) AS memories").first<Record<string,number>>());
  let before: Record<string,number> | null = null;
  try {
    before = await counts();
    const sample = new Uint8Array(MEDIA_CHUNK_BYTES + 17);
    for (let i=0;i<sample.length;i++) sample[i]=i%251;
    const objectKey = `groups/${group}/media/chunk-test`;
    await store.put(objectKey,sample.buffer,{contentType:"application/octet-stream"});
    const obj = await store.get(objectKey);
    if (!obj || await mediaDigest(await obj.arrayBuffer()) !== await mediaDigest(sample.buffer)) throw new Error("storage_round_trip_failed");
    await store.put(objectKey,sample.buffer,{contentType:"application/octet-stream"});
    result.chunkRoundTrip=true;
    result.duplicateWrite=true;
    await store.delete(objectKey);
    let cancelled=false;
    try { await store.put(objectKey,sample.buffer,{contentType:"application/octet-stream"}); }
    catch (error) { cancelled = error instanceof MediaLimitError && error.code === "cancelled"; }
    if (!cancelled || await store.get(objectKey)) throw new Error("storage_delete_failed");
    result.deleteAndRetry=true;

    const challenge = `HOMEAI_${crypto.randomUUID().replaceAll("-","").slice(0,12)}`;
    const textKey = `groups/${group}/media/text-test`;
    await store.put(textKey,new TextEncoder().encode(`検証文字列：${challenge}`).buffer,{contentType:"text/plain"});
    const message = {line_message_id:"synthetic-text-test",media_key:textKey,mime_type:"text/plain",sender_name:"Synthetic verification",type:"file",unsent:0} as MessageRow;
    const media = await mediaInputs(env,[message],1);
    try {
      const response = await answer(env,"これは合成データのみの疎通試験です。添付テキストの検証文字列をそのまま1行で返してください。","添付の検証文字列は何ですか。",media.inputs,"low",undefined,{modelTimeoutMs:20_000,deadlineMs:45_000,maxOutputTokens:128});
      if (!response.model || !response.text.includes(challenge)) throw new Error("gemini_attachment_failed");
      result.geminiAttachment=true;
      result.model=response.model;
    } finally { await media.cleanup(); }

    const connection = await checkLineConnection(env);
    result.lineAuthentication=connection.bot;
    result.lineWebhook=connection.webhook;
    if (!connection.webhook) throw new Error("line_webhook_not_active");
    result.lineNotification="not_requested";
    if (notify) {
      const target=await getBoundGroup(env);
      if (!target || !/^C[a-f0-9]{32}$/i.test(target)) throw new Error("bound_group_unavailable");
      if (connection.freeMessagesRemaining !== null && connection.freeMessagesRemaining > 0) {
        const sent=await pushText(env,target,"[Home AI 動作確認] 添付保存をR2からD1へ変更し、保存・読込・AI応答の試験が成功しました。",crypto.randomUUID());
        if (!sent.ok) throw new Error(`line_send_failed_${sent.status}`);
        result.lineNotification="accepted";
      } else result.lineNotification="skipped_no_confirmed_free_quota";
    }
    result.state=result.r2BindingAbsent ? "passed" : "failed";
  } catch (error) {
    // Stable categories only: external error messages can contain credentials or URLs.
    const message=error instanceof Error ? error.message : "verification_failed";
    result.error=/^[a-z_]+(?:_[0-9]+)?$/.test(message) ? message : "verification_failed";
  } finally {
    try { await store.deleteGroup(group); result.testDataRemoved=true; } catch { result.testDataRemoved=false; result.state="failed"; }
    try { const after=await counts(); result.dataCounts=after; result.householdCountsUnchanged=JSON.stringify(before)===JSON.stringify(after); } catch { result.householdCountsUnchanged=false; }
    if (!result.householdCountsUnchanged) result.state="failed";
    result.checkedAt=Date.now();
    const value=JSON.stringify(result);
    await env.DB.batch([
      env.DB.prepare("UPDATE app_state SET value=?,updated_at=? WHERE key=?").bind(value,Date.now(),key),
      env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('storage_verification_latest',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(value,Date.now()),
    ]);
  }
}
