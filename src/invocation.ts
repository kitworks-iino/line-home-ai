import type { LineTextMessage, MessageRow } from "./types.js";

export const DEFAULT_IMPLICIT_FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;

export function mentionsAnotherUser(message: LineTextMessage): boolean {
  return message.mention?.mentionees.some((mention) => mention.type === "user" && mention.isSelf !== true) ?? false;
}

export function isImplicitAssistantFollowup(
  previous: Pick<MessageRow, "role" | "created_at" | "unsent"> | null,
  currentTimestamp: number,
  quotedMessageId: string | null,
  windowMs = DEFAULT_IMPLICIT_FOLLOWUP_WINDOW_MS,
): boolean {
  if (quotedMessageId || !previous || previous.unsent || previous.role !== "assistant") return false;
  const age = currentTimestamp - previous.created_at;
  return age >= 0 && age <= windowMs;
}
