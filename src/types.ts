export type ThinkingLevel = "low" | "medium" | "high";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  EVENT_QUEUE: Queue<QueuePayload>;
  LINE_CHANNEL_ID: string;
  LINE_CHANNEL_SECRET: string;
  GEMINI_API_KEY: string;
  SETUP_CODE: string;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODELS: string;
  GEMINI_MEMORY_MODEL: string;
  DEFAULT_THINKING_LEVEL: string;
  BOT_DISPLAY_NAME: string;
  MEMORY_BATCH_SIZE: string;
  RECENT_MESSAGE_LIMIT: string;
  MAX_MEDIA_CONTEXT: string;
  R2_STORAGE_HARD_LIMIT_BYTES: string;
}

export interface LineQueuePayload {
  kind?: "line";
  destination: string;
  event: LineWebhookEvent;
  receivedAt: number;
}

export interface MemoryQueuePayload {
  kind: "memory";
  groupId: string;
  requestedAt: number;
}

export type QueuePayload = LineQueuePayload | MemoryQueuePayload;

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

export interface LineSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMentionee {
  index: number;
  length: number;
  type: "user" | "all";
  userId?: string;
  isSelf?: boolean;
}

export interface LineTextMessage {
  id: string;
  type: "text";
  text: string;
  quoteToken?: string;
  quotedMessageId?: string;
  mention?: { mentionees: LineMentionee[] };
}

export interface LineMediaMessage {
  id: string;
  type: "image" | "video" | "audio" | "file";
  fileName?: string;
  fileSize?: number;
  quoteToken?: string;
  quotedMessageId?: string;
}

export interface LineLocationMessage {
  id: string;
  type: "location";
  title?: string;
  address?: string;
  latitude: number;
  longitude: number;
  quotedMessageId?: string;
}

export interface LineStickerMessage {
  id: string;
  type: "sticker";
  packageId: string;
  stickerId: string;
  stickerResourceType?: string;
  keywords?: string[];
  quotedMessageId?: string;
}

export type LineMessage = LineTextMessage | LineMediaMessage | LineLocationMessage | LineStickerMessage | { id: string; type: string; quotedMessageId?: string };

export interface LineWebhookEvent {
  type: string;
  mode?: "active" | "standby";
  timestamp: number;
  source: LineSource;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery: boolean };
  replyToken?: string;
  message?: LineMessage;
  unsend?: { messageId: string };
}

export interface GroupRow {
  group_id: string;
  created_at: number;
  persona: string | null;
  thinking_level: ThinkingLevel;
  memory_cursor_at: number;
  memory_cursor_message_id: string;
}

export interface MemberRow {
  group_id: string;
  user_id: string;
  display_name: string;
  role: "admin" | "member";
  approved_at: number;
  active: number;
}

export interface MessageRow {
  id: string;
  group_id: string;
  line_message_id: string;
  webhook_event_id: string | null;
  sender_user_id: string | null;
  sender_name: string;
  role: "user" | "assistant";
  type: string;
  text: string | null;
  media_key: string | null;
  mime_type: string | null;
  media_size: number | null;
  quoted_message_id: string | null;
  created_at: number;
  unsent: number;
}

export interface MemoryRow {
  id: number;
  group_id: string;
  subject_key: string;
  memory_key: string;
  content: string;
  confidence: number;
  manual: number;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface SummaryRow {
  id: number;
  group_id: string;
  summary: string;
  created_at: number;
}
