interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}
interface R2ObjectBody {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Object { key: string; size: number }
interface R2Objects { objects: R2Object[]; truncated: boolean; cursor?: string }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
}
interface Queue<Body = unknown> { send(body: Body, options?: { contentType?: "json" | "text" | "bytes"; delaySeconds?: number }): Promise<void> }
interface Message<Body = unknown> { body: Body; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface MessageBatch<Body = unknown> { queue: string; messages: Message<Body>[] }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
interface ExportedHandler<Env = unknown, QueueBody = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  queue?(batch: MessageBatch<QueueBody>, env: Env, ctx: ExecutionContext): void | Promise<void>;
}
