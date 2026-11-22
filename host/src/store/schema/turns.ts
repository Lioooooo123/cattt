import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversations, messages } from "./conversations.ts";

// 发布宿主本机执行资源；包括恢复快照，永不进入复制或 change_log。
export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  triggerMessageId: text("trigger_message_id").notNull().references(() => messages.id),
  publicationEpoch: text("publication_epoch"),
  requestId: text("request_id").unique(),
  status: text("status", { enum: ["queued", "generating", "completed", "stopped", "superseded", "failed"] }).notNull(),
  replyMessageId: text("reply_message_id").references(() => messages.id),
  errorCode: text("error_code"),
  cancelReason: text("cancel_reason"),
  visibleLength: integer("visible_length"),
  firstTokenAt: integer("first_token_at"),
  heartbeatAt: integer("heartbeat_at").notNull(),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  draftText: text("draft_text").notNull(),
  eventSeq: integer("event_seq").notNull(),
  supersededByTurnId: text("superseded_by_turn_id"),
}, (table) => [
  index("turns_pending").on(table.status, table.createdAt),
  index("turns_conversation").on(table.conversationId, table.createdAt),
  check("turns_status", sql`${table.status} IN ('queued','generating','completed','stopped','superseded','failed')`),
]);
