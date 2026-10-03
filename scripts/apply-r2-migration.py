from pathlib import Path
import json
r=Path(__file__).resolve().parents[1]
def replace(name,old,new):
 p=r/name;s=p.read_text();assert old in s,(name,old[:100]);p.write_text(s.replace(old,new))
p=r/'wrangler.jsonc';c=json.loads(p.read_text());c.pop('r2_buckets');c['vars'].pop('R2_STORAGE_HARD_LIMIT_BYTES');c['vars'].update(MEDIA_STORAGE_LIMIT_BYTES='300000000',MEDIA_MAX_FILE_BYTES='16777216');c['preview_urls']=False;c['d1_databases']=[{'binding':'DB','database_name':'line-home-ai-db','database_id':'ace163ad-2bb3-46bf-977f-606a8eed7e60'},{'binding':'MEDIA_DB','database_name':'line-home-ai-media-db','database_id':'ad6d7de6-df50-48e0-9316-2133a7bd83df'}];p.write_text(json.dumps(c,indent=2)+'\n')
replace('src/types.ts','  MEDIA: R2Bucket;','  MEDIA_DB: D1Database;')
replace('src/types.ts','  R2_STORAGE_HARD_LIMIT_BYTES: string;','  MEDIA_STORAGE_LIMIT_BYTES: string;\n  MEDIA_MAX_FILE_BYTES: string;')
replace('src/types.ts','export type QueuePayload = LineQueuePayload | MemoryQueuePayload | DiagnosticQueuePayload | CleanupQueuePayload;','export interface StorageVerificationPayload { kind: "verify-storage"; release: string; runId: string; notify?: boolean }\nexport type QueuePayload = LineQueuePayload | MemoryQueuePayload | DiagnosticQueuePayload | CleanupQueuePayload | StorageVerificationPayload;')
replace('src/types.ts','Queue<MemoryQueuePayload | DiagnosticQueuePayload | CleanupQueuePayload>','Queue<MemoryQueuePayload | DiagnosticQueuePayload | CleanupQueuePayload | StorageVerificationPayload>')
p=r/'src/cloudflare.d.ts';s=p.read_text();s=s[:s.index('interface R2ObjectBody')]+s[s.index('interface Queue<'):];p.write_text(s)
replace('src/line.ts','import { canStoreWithinR2Limit, r2HardLimitBytes, r2StorageUsage } from "./r2-guard.js";','import { mediaFileLimitBytes, MediaLimitError, readBoundedMedia } from "./media-store.js";')
p=r/'src/line.ts';s=p.read_text();a=s.index('  if (!res.ok)',s.index('export async function getMessageContent'));b=s.index('\n}\n',a);s=s[:a]+'''  if (res.status === 404 || res.status === 410) throw new MediaLimitError("expired");
  if (!res.ok) throw new Error(`LINE content fetch failed: ${res.status}`);
  const buffer = await readBoundedMedia(res, mediaFileLimitBytes(env));
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return { buffer, contentType };'''+s[b:]
s=s.replace('init: RequestInit = {}): Promise<Response>', 'init: RequestInit = {}, maxResponseBytes?: number): Promise<Response>').replace('lineApiTimeoutMs(env), "LINE Messaging API");','lineApiTimeoutMs(env), "LINE Messaging API", maxResponseBytes);').replace('`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`);','`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {}, mediaFileLimitBytes(env));')
s+='''
// Administrative verification returns booleans/quotas, never tokens or profile identifiers.
export async function checkLineConnection(env: Env): Promise<{bot: boolean; webhook: boolean; freeMessagesRemaining: number | null}> {
  const bot = await lineFetch(env, "https://api.line.me/v2/bot/info");
  if (!bot.ok) throw new Error(`LINE bot authentication failed: ${bot.status}`);
  const hook = await lineFetch(env, "https://api.line.me/v2/bot/channel/webhook/endpoint");
  if (!hook.ok) throw new Error(`LINE webhook lookup failed: ${hook.status}`);
  const endpoint = await hook.json() as { endpoint?: string; active?: boolean };
  const quota = await lineFetch(env, "https://api.line.me/v2/bot/message/quota");
  const consumption = await lineFetch(env, "https://api.line.me/v2/bot/message/quota/consumption");
  let remaining: number | null = null;
  if (quota.ok && consumption.ok) {
    const q = await quota.json() as {type?:string;value?:number};
    const c = await consumption.json() as {totalUsage?:number};
    if (q.type === "limited" && q.value === 200 && typeof c.totalUsage === "number") remaining = Math.max(0, 200 - c.totalUsage);
  }
  return {bot:true, webhook:endpoint.active === true && endpoint.endpoint === "https://line-home-ai.kitworks.workers.dev/webhook", freeMessagesRemaining:remaining};
}
''';p.write_text(s)
p=r/'src/timeout.ts';s=p.read_text();s='import { readBoundedMedia } from "./media-store.js";\n'+s;s=s.replace('  label: string,\n):','  label: string,\n  maxResponseBytes?: number,\n):').replace('const body = response.body ? await response.arrayBuffer() : null;','const body = response.body ? (maxResponseBytes === undefined ? await response.arrayBuffer() : await readBoundedMedia(response, maxResponseBytes)) : null;');p.write_text(s)
p=r/'src/processor.ts';s=p.read_text();s='import { runStorageVerification } from "./storage-verification.js";\nimport { mediaStore, MediaLimitError, mediaFailureMessage } from "./media-store.js";\n'+s
start=s.index('  const prefix = ',s.index('async function removeGroupMedia'));end=s.index('\n}\n',start);s=s[:start]+'  await mediaStore(env).deleteGroup(groupId);'+s[end:]
s=s.replace('  let text: string | null = textOverride ?? null;','''  // Queue redelivery reuses committed metadata instead of fetching/saving again.
  const existing = await env.DB.prepare("SELECT * FROM messages WHERE group_id=? AND line_message_id=?")
    .bind(groupId, message.id).first<MessageRow>();
  if (existing) return existing;
  let cancelled = false;
  let text: string | null = textOverride ?? null;''')
a=s.index('    const content = await getMessageContent');b=s.index('\n  } else {',a);s=s[:a]+'''    try {
      const content = await getMessageContent(env, message.id);
      const key = `groups/${groupId}/media/${message.id}`;
      const metadata: Record<string, string> = { groupId, lineMessageId: message.id, senderUserId: userId, senderName: displayName, messageType: message.type };
      if ("fileName" in message && message.fileName) metadata.fileName = message.fileName;
      await mediaStore(env).put(key, content.buffer, { contentType: content.contentType, metadata });
      mediaKey = key;
      mimeType = content.contentType;
      mediaSize = content.buffer.byteLength;
      if (message.type === "file" && "fileName" in message && message.fileName) text = `[ファイル: ${message.fileName}]`;
    } catch (error) {
      if (!(error instanceof MediaLimitError)) throw error;
      cancelled = error.code === "cancelled";
      text = `[添付未保存] ${mediaFailureMessage(error, env)}`;
    }'''+s[b:]
s=s.replace('  return saveUserMessage(env, {','  const saved = await saveUserMessage(env, {',1);a=s.index('\n}\n',s.index('  const saved = await saveUserMessage'));s=s[:a]+'''\n  if (cancelled) {
    await unsendMessage(env, groupId, message.id);
    return { ...saved, unsent: 1, text: null, media_key: null, mime_type: null, media_size: null };
  }
  return saved;'''+s[a:]
s=s.replace('''        const mediaKey = await unsendMessage(env, groupId, event.unsend.messageId);
        if (mediaKey) await env.MEDIA.delete(mediaKey);''','''        // Delete first and retain a cancellation key, so retries cannot restore cancelled media.
        await mediaStore(env).delete(`groups/${groupId}/media/${event.unsend.messageId}`);
        await unsendMessage(env, groupId, event.unsend.messageId);''')
needle='    const saved = await persistIncoming(env, groupId, key, userId, displayName, event.message, event.timestamp, deepPrompt);';s=s.replace(needle,needle+'''
    if (saved.unsent) { await completeEvent(env, key); return; }
    if (["image", "video", "audio", "file"].includes(saved.type) && !saved.media_key && saved.text?.startsWith("[添付未保存]")) {
      await deliver(env, key, groupId, event.replyToken, event.timestamp, saved.text, false);
      await completeEvent(env, key);
      return;
    }''')
s=s.replace('  if (payload.kind === "cleanup") {','''  if (payload.kind === "verify-storage") {
    await runStorageVerification(env, payload.release, payload.runId, payload.notify === true);
    return;
  }
  if (payload.kind === "cleanup") {''');p.write_text(s)
p=r/'src/gemini.ts';s=p.read_text();s='import { mediaStore } from "./media-store.js";\n'+s;s=s.replace('const R2_LIMIT_MARKER_MIME = "application/x-line-home-ai-r2-limit";\n','');s=s.replace('    const obj = await env.MEDIA.get(m.media_key!);\n    if (!obj) continue;\n    const buf = await obj.arrayBuffer();','''    let buf: ArrayBuffer;
    try {
      const obj = await mediaStore(env).get(m.media_key!);
      if (!obj) throw new Error("Attachment is not stored");
      buf = await obj.arrayBuffer();
    } catch {
      inputs.push({type:"text", text:`添付 message_id=${m.line_message_id} は保存先から取得できず、内容を参照できません。内容を見た・聞いたと述べないでください。`});
      continue;
    }''');a=s.index('    if (mime === R2_LIMIT_MARKER_MIME)');b=s.index('    if (isTextLike(mime))',a);s=s[:a]+s[b:];p.write_text(s)
p=r/'src/commands.ts';s=p.read_text().replace('import { formatDecimalBytes, r2HardLimitBytes, r2StorageUsage } from "./r2-guard.js";','import { formatMediaBytes, mediaStore } from "./media-store.js";').replace('/usage — R2添付ストレージの実使用量とハード上限','/usage — D1添付ストレージの使用量と保存上限');a=s.index('      const usage=await r2StorageUsage(env)');b=s.index('\n    }',a);s=s[:a]+'''      const usage = await mediaStore(env).usage();
      return {text:`D1 添付ストレージ\\n保存量: ${formatMediaBytes(usage.bytes)} / ${formatMediaBytes(usage.limit)}\\nファイル数: ${usage.objects}\\n1ファイルの上限: ${(usage.maxFileBytes / 1024 / 1024).toFixed(1)} MiB\\nR2は使用していません。\\n\\n既存データを自動で間引くことはありません。容量上限では新規添付の保存を止めて通知します。Workers FreeのD1利用枠を超えると処理はエラーで停止し、プランを自動変更しません。Gemini・LINEなど外部サービスの利用条件は別です。`};'''+s[b:];p.write_text(s)
p=r/'src/schema.ts';s=p.read_text().replace('let initialized = false;','const initialized = new WeakMap<D1Database, Promise<void>>();\nconst SCHEMA_VERSION = "home-ai-schema:1";');a=s.index('export async function ensureSchema');s=s[:a]+'''export async function ensureSchema(env: Env): Promise<void> {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  let ready = initialized.get(env.DB);
  if (!ready) {
    ready = (async () => {
      try {
        const marker = await env.DB.prepare("SELECT value FROM app_state WHERE key=?").bind(SCHEMA_VERSION).first<{value:string}>();
        if (marker?.value === "ready") return;
      } catch (error) { if (!/no such table/i.test(String(error))) throw error; }
      await env.DB.batch(SCHEMA_STATEMENTS.map(statement => env.DB.prepare(statement)));
      await migrateSchema(env);
      await env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(SCHEMA_VERSION, "ready", Date.now()).run();
    })();
    initialized.set(env.DB, ready);
    void ready.catch(() => initialized.delete(env.DB));
  }
  await ready;
}
''';p.write_text(s)
p=r/'src/index.ts';s=p.read_text();s='import { ensureMediaSchema, mediaCapacityBytes, mediaFileLimitBytes } from "./media-store.js";\nimport { STORAGE_RELEASE } from "./storage-verification.js";\n'+s;s=s.replace('      const configured = Object.values(required).every(Boolean);','''      let mediaDatabase = true;
      try { await ensureMediaSchema(env); } catch { mediaDatabase = false; }
      const configured = Object.values(required).every(Boolean);''');s=s.replace('ok: database,','ok: database && mediaDatabase,').replace('ready: database && configured,','ready: database && mediaDatabase && configured,').replace('        database,','''        database,
        storage: { backend: "d1", ready: mediaDatabase, r2Required: false, capacityBytes: mediaCapacityBytes(env), maxFileBytes: mediaFileLimitBytes(env) },''').replace('{ status: database ? 200 : 503 }','{ status: database && mediaDatabase ? 200 : 503 }')
s=s.replace('      const latencyRow = ','''      const verificationRow = database ? await env.DB.prepare("SELECT value FROM app_state WHERE key='storage_verification_latest'").first<{value:string}>().catch(()=>null) : null;
      let storageVerification: unknown = null;
      try { if (verificationRow) storageVerification = JSON.parse(verificationRow.value); } catch { /* Invalid diagnostic JSON is not exposed. */ }
      const latencyRow = ''').replace('version:RELEASE,','version:STORAGE_RELEASE,\n        modelDiagnosticsRelease:RELEASE,\n        storageVerification,');p.write_text(s)
p=r/'tests/api-contract.test.mjs';s=p.read_text();s="import { mediaEnv as makeMediaEnv } from './helpers/sqlite-d1.mjs';\nimport { mediaStore } from '../.test-dist/media-store.js';\n"+s;s=s.replace('media_key:id,','media_key:`groups/test/media/${id}`,');s=s.replace("const mediaEnv={MEDIA:{async get(){return {async arrayBuffer(){return new Uint8Array([1,2,3]).buffer;}};}}};",'''const mediaEnv=makeMediaEnv();
for (const id of ['a','b','c','svg','audio']) await mediaStore(mediaEnv).put(`groups/test/media/${id}`,new Uint8Array([1,2,3]).buffer,{contentType:'application/octet-stream'});''');s=s.replace("const env={MEDIA:{async get(){throw new Error('storage must not be read');}}};",'const env={}; // Zero context must never open a database.');p.write_text(s)
for name in ['src/r2-guard.ts','tests/r2-guard.test.mjs','docs/R2_FREE_TIER.md']:
 (r/name).unlink(missing_ok=True)
p=r/'package.json';c=json.loads(p.read_text());c['version']='1.7.0';c['scripts']['test:runtime']='node scripts/runtime-smoke.mjs';c['scripts']['check']='npm run typecheck && npm test && npm run test:runtime && npm run dry-run';c['devDependencies'].update(miniflare='5.20260831.0-alpha',esbuild='0.28.1');p.write_text(json.dumps(c,indent=2)+'\n')
p=r/'README.md';s=p.read_text().replace('- Cloudflare R2','- Cloudflare D1 (dedicated attachment database; no R2 subscription required)').replace('D1, R2, the processing Queue and the dead-letter Queue are declared in `wrangler.jsonc` and are automatically provisioned/bound by current Wrangler/Cloudflare deployment behavior.','The two existing D1 databases are explicitly bound in `wrangler.jsonc`; the existing Queues are maintained. Forks must set their own D1 IDs. R2 is not provisioned.').replace('Stores binary media in R2','Stores binary media in a dedicated D1 database').replace('- Keeps R2 binary storage at or below the full **10 GB Standard free-storage boundary** (`10,000,000,000` bytes) instead of using an arbitrary safety margin; `/usage` shows actual R2 object bytes.','- Stores at most **300 MB raw attachments total / 16 MiB per file**, using atomic D1 transactions and checksums. `/usage` shows persisted bytes. This is smaller than the former R2 capacity. No automatic data eviction or new billing subscription is used.').replace('R2 billing/free-tier behavior: **[R2 Free Tier](docs/R2_FREE_TIER.md)**','Attachment limits and migration: **[D1 media storage](docs/D1_MEDIA.md)**');p.write_text(s)
p=r/'docs/ARCHITECTURE.md';s=p.read_text().replace('copied into R2','copied into the dedicated D1 media database').replace('corresponding R2 object','corresponding D1 attachment and chunks').replace("every R2 object under that group's prefix","every D1 attachment for that group").replace('copied to R2','copied to D1').replace('stored in R2','stored in D1');s+='\n\n## R2-free storage (1.7.0)\n\nMEDIA_DB is separate from the conversation DB. See [D1 storage](D1_MEDIA.md) for capacities, transactions, cancellation handling, bounded downloads and verification. R2 bindings are removed and preview URLs are disabled. Schema initialization is cached per binding; a persistent schema marker avoids repeated cold-start migrations.\n';p.write_text(s)
p=r/'docs/SETUP.md';s=p.read_text();a=s.index('## 3. CloudflareでR2');b=s.index('## 4.',a);s=s[:a]+'''## 3. Workers Freeと専用D1を確認する

R2を有効化する操作は不要です。R2の解約予約は取り消しません。

- 会話用：DB → line-home-ai-db
- 添付用：MEDIA_DB → line-home-ai-media-db

既存環境では両方作成済みで、wrangler.jsoncにIDを明記しています。別アカウントへの配備時だけ、そのアカウントのD1 IDへ変更します。添付は元データ合計300 MB、1ファイル16 MiBまで。上限では新規添付を保存せず通知し、既存データを自動で削除しません。[詳細](D1_MEDIA.md)。

---

'''+s[b:];a=s.index('### D1 / R2 / Queues');b=s.index('**D1 migration',a);s=s[:a]+'''### 既存D1とQueuesを維持する

DBとMEDIA_DBは既存D1の明示IDに接続します。R2の自動作成はありません。line-home-ai-events、line-home-ai-memoryと各dead-letter queueを維持します。

'''+s[b:];s=s.replace('- `R2_STORAGE_HARD_LIMIT_BYTES=10000000000`','- `MEDIA_STORAGE_LIMIT_BYTES=300000000`\n- `MEDIA_MAX_FILE_BYTES=16777216`').replace('続いてR2の実使用量も確認します。','続いてD1添付保存の使用量も確認します。').replace('初期状態ではほぼ0 GB / 10 GBになります。','初期状態では0 bytes / 300 MBです。').replace('`/usage` — R2の実保存量 / 10GBハード上限 / オブジェクト数','`/usage` — D1添付の保存量 / 合計300 MB・1ファイル16 MiBの上限 / ファイル数').replace('対応するR2メディアを削除','対応するD1添付とチャンクを削除');p.write_text(s)
