export class UpstreamTimeoutError extends Error {
  constructor(public readonly label: string, public readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

export function boundedMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError(label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
