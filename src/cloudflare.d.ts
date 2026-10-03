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
interface Queue<Body = unknown> { send(body: Body, options?: { contentType?: "json" | "text" | "bytes"; delaySeconds?: number }): Promise<void> }
interface Message<Body = unknown> { body: Body; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface MessageBatch<Body = unknown> { queue: string; messages: Message<Body>[] }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
interface ExportedHandler<Env = unknown, QueueBody = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  queue?(batch: MessageBatch<QueueBody>, env: Env, ctx: ExecutionContext): void | Promise<void>;
}
