import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { messages } from "./conversations.ts";
import { households, members } from "./identity.ts";
import { memories } from "./knowledge.ts";

/** 证明随 confirmed 记忆保存，内容由被引用的消息修订提供。 */
export const memoryExtractionDependencies = sqliteTable("memory_extraction_dependencies", {
  memoryId: text("memory_id").notNull().references(() => memories.id),
  contextMessageId: text("context_message_id").notNull().references(() => messages.id),
  contextRevision: integer("context_revision").notNull(),
}, (table) => [
  primaryKey({ columns: [table.memoryId, table.contextMessageId] }),
  index("memory_extraction_dependencies_message").on(table.contextMessageId),
  check("memory_extraction_dependencies_revision", sql`${table.contextRevision} > 0`),
]);

export const pendingMemoryExtractions = sqliteTable("pending_memory_extractions", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  sourceMemberId: text("source_member_id").notNull().references(() => members.id),
  sourceMessageId: text("source_message_id").notNull().references(() => messages.id),
  sourceRevision: integer("source_revision").notNull(),
  reason: text("reason", { enum: ["subject", "source"] }).notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
}, (table) => [
  uniqueIndex("pending_memory_extractions_source_fact").on(table.sourceMessageId, table.sourceRevision, table.key, table.value),
  index("pending_memory_extractions_household").on(table.householdId),
  check("pending_memory_extractions_revision", sql`${table.sourceRevision} > 0`),
  check("pending_memory_extractions_reason", sql`${table.reason} IN ('subject', 'source')`),
]);

/** 已发布回复使用过的可撤回知识。原生聊天历史仍独立展示原回复。 */
export const chatReplyKnowledge = sqliteTable("chat_reply_knowledge", {
  messageId: text("message_id").primaryKey().references(() => messages.id),
  references: text("evidence", { mode: "json" }).$type<RecallEvidence[]>().notNull(),
});

export type RecallEvidence =
  | { kind: "memory" | "diary" | "file_description"; id: string; rev: number }
  | { kind: "message"; sourceMemberId: string; sourceMessageId: string; sourceRevision: number };
