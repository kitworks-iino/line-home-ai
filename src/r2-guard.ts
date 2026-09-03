import type { Env } from "./types.js";

export interface R2StorageUsage {
  bytes: number;
  objects: number;
  listOperations: number;
}

export function r2HardLimitBytes(env: Env): number {
  const parsed = Number.parseInt(env.R2_STORAGE_HARD_LIMIT_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000_000_000;
}

export async function r2StorageUsage(env: Env): Promise<R2StorageUsage> {
  let bytes = 0;
  let objects = 0;
  let listOperations = 0;
  let cursor: string | undefined;

  do {
    const page = await env.MEDIA.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
    listOperations += 1;
    for (const object of page.objects) {
      bytes += object.size;
      objects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { bytes, objects, listOperations };
}

export function canStoreWithinR2Limit(currentBytes: number, incomingBytes: number, limitBytes: number): boolean {
  if (currentBytes < 0 || incomingBytes < 0 || limitBytes <= 0) return false;
  return currentBytes + incomingBytes <= limitBytes;
}

export function formatDecimalBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(3)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}
