import type { Env } from "./types.js";

let initialized = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  persona TEXT,
  thinking_level TEXT NOT NULL DEFAULT 'medium',
  memory_cursor_at INTEGER NOT NULL DEFAULT 0,
  memory_cursor_message_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  approved_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS join_requests (
  code TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_join_group_status ON join_requests(group_id, status, expires_at);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  group_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_text TEXT,
  reply_attempted_at INTEGER,
  delivered_at INTEGER,
  push_retry_key TEXT,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  line_message_id TEXT NOT NULL UNIQUE,
  webhook_event_id TEXT,
  sender_user_id TEXT,
  sender_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  type TEXT NOT NULL,
  text TEXT,
  media_key TEXT,
  mime_type TEXT,
  media_size INTEGER,
  quoted_message_id TEXT,
  created_at INTEGER NOT NULL,
  unsent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_group_created ON messages(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_quote ON messages(group_id, line_message_id, role);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  manual INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(group_id, subject_key, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_memories_group_active ON memories(group_id, active, updated_at DESC);
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id INTEGER NOT NULL,
  line_message_id TEXT NOT NULL,
  PRIMARY KEY(memory_id, line_message_id)
);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_sources (
  summary_id INTEGER NOT NULL,
  line_message_id TEXT NOT NULL,
  PRIMARY KEY(summary_id, line_message_id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_group ON summaries(group_id, created_at DESC);
`;

async function hasColumn(env: Env, table: string, column: string): Promise<boolean> {
  const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{name:string}>();
  return (rows.results ?? []).some((row) => row.name === column);
}

async function migrateSchema(env: Env): Promise<void> {
  // CREATE TABLE IF NOT EXISTS does not add columns to an existing D1 table.
  // Keep additive migrations here so future deployments can upgrade in place.
  if (!(await hasColumn(env, "groups", "memory_cursor_message_id"))) {
    await env.DB.exec("ALTER TABLE groups ADD COLUMN memory_cursor_message_id TEXT NOT NULL DEFAULT ''");
  }
  if (!(await hasColumn(env, "webhook_events", "delivered_at"))) {
    await env.DB.exec("ALTER TABLE webhook_events ADD COLUMN delivered_at INTEGER");
  }
  if (!(await hasColumn(env, "webhook_events", "push_retry_key"))) {
    await env.DB.exec("ALTER TABLE webhook_events ADD COLUMN push_retry_key TEXT");
  }
}

export async function ensureSchema(env: Env): Promise<void> {
  if (initialized) return;
  await env.DB.exec(SCHEMA);
  await migrateSchema(env);
  initialized = true;
}
