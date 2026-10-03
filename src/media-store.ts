import type { Env } from "./types.js";
import { asInt, base64FromArrayBuffer } from "./util.js";

// Base64 TEXT avoids D1's BLOB -> numeric-array JSON expansion in a 128 MB Worker.
// Each encoded row is <2 MB. 300 MB raw leaves room under D1 Free's 500 MB DB cap.
export const MEDIA_CHUNK_BYTES = 1024 * 1024;
export const MEDIA_CAPACITY_BYTES = 300_000_000;
export const MEDIA_FILE_BYTES = 16 * 1024 * 1024;
const schemaReady = new WeakMap<D1Database, Promise<void>>();

type MediaEnv = Pick<Env, "MEDIA_DB" | "MEDIA_STORAGE_LIMIT_BYTES" | "MEDIA_MAX_FILE_BYTES">;
export type MediaFailure = "file_limit" | "capacity" | "cancelled" | "expired";
export class MediaLimitError extends Error {
  constructor(public readonly code: MediaFailure) { super(`Attachment unavailable: ${code}`); this.name = "MediaLimitError"; }
}
export function mediaFileLimitBytes(env: MediaEnv): number {
  return asInt(env.MEDIA_MAX_FILE_BYTES, MEDIA_FILE_BYTES, 1, MEDIA_FILE_BYTES);
}
export function mediaCapacityBytes(env: MediaEnv): number {
  return asInt(env.MEDIA_STORAGE_LIMIT_BYTES, MEDIA_CAPACITY_BYTES, 1, MEDIA_CAPACITY_BYTES);
}
export function mediaFailureMessage(error: MediaLimitError, env: MediaEnv): string {
  if (error.code === "file_limit") return `添付は保存していません。1ファイルの上限は${(mediaFileLimitBytes(env) / 1024 / 1024).toFixed(1)} MiBです。小さいファイルで送り直してください。`;
  if (error.code === "capacity") return "添付は保存していません。無料の添付保存領域が上限に達しました。既存データは削除していません。通常のテキスト会話は継続できます。";
  if (error.code === "expired") return "添付は保存していません。LINE上の取得期限が過ぎたか、内容を取得できなくなっています。ファイルを送り直してください。";
  return "この添付は送信取消済みのため保存しません。";
}
export function formatMediaBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${bytes.toLocaleString("en-US")} bytes`;
}
function groupFromKey(key: string): string {
  const match = /^groups\/([^/]{1,128})\/media\/([^/]{1,128})$/.exec(key);
  if (!match) throw new Error("Invalid attachment key");
  return match[1]!;
}
export async function mediaDigest(buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), b => b.toString(16).padStart(2, "0")).join("");
}

export const MEDIA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS media_usage(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL CHECK(bytes>=0), objects INTEGER NOT NULL CHECK(objects>=0), version INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO media_usage(id,bytes,objects,version) VALUES(1,0,0,1)`,
  `CREATE TABLE IF NOT EXISTS media_objects(key TEXT PRIMARY KEY, group_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), content_type TEXT NOT NULL, metadata TEXT NOT NULL, digest TEXT NOT NULL, chunks INTEGER NOT NULL, capacity_limit INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS media_objects_group ON media_objects(group_id)`,
  `CREATE TABLE IF NOT EXISTS media_chunks(object_key TEXT NOT NULL REFERENCES media_objects(key) ON DELETE CASCADE, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(object_key,ordinal)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS media_tombstones(key TEXT PRIMARY KEY, group_id TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS media_tombstones_group ON media_tombstones(group_id)`,
  `CREATE TRIGGER IF NOT EXISTS media_quota BEFORE INSERT ON media_objects BEGIN SELECT CASE WHEN (SELECT bytes FROM media_usage WHERE id=1)+NEW.size>NEW.capacity_limit THEN RAISE(ABORT,'MEDIA_CAPACITY_LIMIT') END; END`,
  `CREATE TRIGGER IF NOT EXISTS media_count_insert AFTER INSERT ON media_objects BEGIN UPDATE media_usage SET bytes=bytes+NEW.size,objects=objects+1 WHERE id=1; END`,
  `CREATE TRIGGER IF NOT EXISTS media_count_delete AFTER DELETE ON media_objects BEGIN UPDATE media_usage SET bytes=bytes-OLD.size,objects=objects-1 WHERE id=1; END`,
] as const;

export async function ensureMediaSchema(env: MediaEnv): Promise<void> {
  const db = env.MEDIA_DB;
  if (!db) throw new Error("D1 attachment binding MEDIA_DB is unavailable");
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = (async () => {
      try {
        const row = await db.prepare("SELECT version FROM media_usage WHERE id=1").first<{ version: number }>();
        if (row?.version === 1) return;
      } catch (error) {
        if (!/no such table/i.test(String(error))) throw error;
      }
      const results = await db.batch(MEDIA_SCHEMA.map(sql => db.prepare(sql)));
      if (results.some(result => !result.success)) throw new Error("Attachment schema initialization failed");
    })();
    schemaReady.set(db, ready);
    void ready.catch(() => schemaReady.delete(db));
  }
  await ready;
}

export interface StoredMedia {
  key: string; size: number; contentType: string; digest: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface ObjectRow { key: string; size: number; content_type: string; digest: string; chunks: number }
export function mediaStore(env: MediaEnv) {
  const db = env.MEDIA_DB;
  return {
    async put(key: string, buffer: ArrayBuffer, options: { contentType: string; metadata?: Record<string, string> }): Promise<void> {
      const group = groupFromKey(key);
      if (buffer.byteLength > mediaFileLimitBytes(env)) throw new MediaLimitError("file_limit");
      const metadata = JSON.stringify(options.metadata ?? {});
      if (new TextEncoder().encode(metadata).byteLength > 8192 || options.contentType.length > 256) throw new Error("Attachment metadata too large");
      await ensureMediaSchema(env);
      const digest = await mediaDigest(buffer);
      const chunks: string[] = [];
      for (let i = 0; i < buffer.byteLength; i += MEDIA_CHUNK_BYTES) chunks.push(base64FromArrayBuffer(buffer.slice(i, i + MEDIA_CHUNK_BYTES)));
      const insert = db.prepare(`INSERT INTO media_objects(key,group_id,size,content_type,metadata,digest,chunks,capacity_limit,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM media_objects WHERE key=?) AND NOT EXISTS(SELECT 1 FROM media_tombstones WHERE key=?)`)
        .bind(key, group, buffer.byteLength, options.contentType, metadata, digest, chunks.length, mediaCapacityBytes(env), Date.now(), key, key);
      const statements = [insert];
      if (chunks.length) {
        // <=16 chunks; 16*3+2 parameters stays under D1's 100-parameter cap.
        const values: unknown[] = [];
        for (let i = 0; i < chunks.length; i++) values.push(key, i, chunks[i]!);
        statements.push(db.prepare(`WITH input(object_key,ordinal,data) AS (VALUES ${chunks.map(() => "(?,?,?)").join(",")})
          INSERT OR IGNORE INTO media_chunks(object_key,ordinal,data)
          SELECT input.object_key,input.ordinal,input.data FROM input
          WHERE EXISTS(SELECT 1 FROM media_objects WHERE key=? AND digest=?)`).bind(...values, key, digest));
      }
      statements.push(db.prepare("SELECT key,size,content_type,digest,chunks FROM media_objects WHERE key=?").bind(key));
      let results: D1Result<ObjectRow>[];
      try {
        results = await db.batch<ObjectRow>(statements);
        if (results.some(result => !result.success)) throw new Error("Attachment transaction failed");
      } catch (error) {
        if (/MEDIA_CAPACITY_LIMIT|Exceeded maximum DB size|maximum account storage limit|database or disk is full/i.test(String(error))) throw new MediaLimitError("capacity");
        throw error; // Retry transient failures. The batch rolls back atomically.
      }
      const saved = results[results.length - 1]?.results?.[0];
      if (!saved) throw new MediaLimitError("cancelled");
      if (saved.digest !== digest || saved.size !== buffer.byteLength) throw new Error("Attachment key collision; original data preserved");
    },
    async get(key: string): Promise<StoredMedia | null> {
      groupFromKey(key);
      await ensureMediaSchema(env);
      const row = await db.prepare("SELECT key,size,content_type,digest,chunks FROM media_objects WHERE key=?").bind(key).first<ObjectRow>();
      if (!row) return null;
      if (row.size < 0 || row.size > MEDIA_FILE_BYTES || row.chunks !== Math.ceil(row.size / MEDIA_CHUNK_BYTES)) throw new Error("Invalid attachment metadata");
      return { key, size: row.size, contentType: row.content_type, digest: row.digest, async arrayBuffer() {
        const output = new Uint8Array(row.size);
        let offset = 0;
        // Four encoded chunks per response bounds memory independently of file size.
        for (let start = 0; start < row.chunks; start += 4) {
          const result = await db.prepare("SELECT ordinal,data FROM media_chunks WHERE object_key=? AND ordinal>=? AND ordinal<? ORDER BY ordinal")
            .bind(key, start, Math.min(row.chunks, start + 4)).all<{ ordinal: number; data: string }>();
          if (!result.success || result.results?.length !== Math.min(4, row.chunks - start)) throw new Error("Incomplete attachment data");
          for (let n = 0; n < result.results.length; n++) {
            const chunk = result.results[n]!;
            if (chunk.ordinal !== start + n) throw new Error("Attachment chunk order invalid");
            const binary = atob(chunk.data);
            const expected = Math.min(MEDIA_CHUNK_BYTES, row.size - offset);
            if (binary.length !== expected) throw new Error("Attachment chunk size invalid");
            for (let j = 0; j < binary.length; j++) output[offset + j] = binary.charCodeAt(j);
            offset += binary.length;
          }
        }
        if (offset !== row.size || await mediaDigest(output.buffer) !== row.digest) throw new Error("Attachment integrity check failed");
        return output.buffer;
      } };
    },
    async delete(key: string): Promise<void> {
      const group = groupFromKey(key);
      await ensureMediaSchema(env);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO media_tombstones(key,group_id) VALUES(?,?)").bind(key, group),
        db.prepare("DELETE FROM media_objects WHERE key=?").bind(key),
      ]);
    },
    async deleteGroup(group: string): Promise<void> {
      if (!group || group.includes("/")) throw new Error("Invalid attachment group");
      await ensureMediaSchema(env);
      await db.batch([
        db.prepare("DELETE FROM media_objects WHERE group_id=?").bind(group),
        db.prepare("DELETE FROM media_tombstones WHERE group_id=?").bind(group),
      ]);
    },
    async usage(): Promise<{ bytes: number; objects: number; limit: number; maxFileBytes: number }> {
      await ensureMediaSchema(env);
      const row = await db.prepare("SELECT bytes,objects FROM media_usage WHERE id=1").first<{ bytes: number; objects: number }>();
      if (!row) throw new Error("Attachment usage is unavailable");
      return { ...row, limit: mediaCapacityBytes(env), maxFileBytes: mediaFileLimitBytes(env) };
    },
  };
}

// Reject oversized streams before buffering them fully, even without Content-Length.
export async function readBoundedMedia(response: Response, limit: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new MediaLimitError("file_limit"); }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new MediaLimitError("file_limit"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output.buffer;
}
