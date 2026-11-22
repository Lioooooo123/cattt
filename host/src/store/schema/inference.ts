import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversations, messages } from "./conversations.ts";
import { households, hosts, members } from "./identity.ts";
import { mailboxLetters } from "./publications.ts";
import { tickets } from "./tickets.ts";

export const proactivePermissions = sqliteTable("proactive_permissions", {
  memberId: text("member_id").primaryKey().references(() => members.id),
  allowed: integer("allowed", { mode: "boolean" }).notNull(),
  revision: integer("revision").notNull(),
  timeZone: text("time_zone").notNull(),
});

// 观察、拒绝和发布均复用此来源键，推断正文不复制进候选。
export const inferenceCandidates = sqliteTable("inference_candidates", {
  sourceMessageId: text("source_message_id").primaryKey().references(() => messages.id),
  sourceRevision: integer("source_revision").notNull(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  sourceMemberId: text("source_member_id").notNull().references(() => members.id),
  hostId: text("host_id").notNull().references(() => hosts.id),
  publicationEpoch: text("publication_epoch").notNull(),
  audience: text("audience", { mode: "json" }).$type<{ memberId: string; revision: number }[]>().notNull(),
  sourceTimeZone: text("source_time_zone").notNull(),
  rule: text("rule", { mode: "json" }).$type<{ version: number; mode: "off" | "observe" | "auto" }>().notNull(),
  topic: text("topic", { enum: ["interview", "exam", "medical", "competition", "defense"] }).notNull(),
  afterAt: integer("after_at").notNull(),
  status: text("status", { enum: ["pending", "observed", "dropped", "published"] }).notNull(),
  reason: text("reason"),
  retryAt: integer("retry_at"),
  resolvedAt: integer("resolved_at"),
  ticketId: text("ticket_id").references(() => tickets.id),
  messageId: text("message_id").references(() => messages.id),
  letterId: text("letter_id").references(() => mailboxLetters.id),
}, (table) => [
  index("inference_ready").on(table.hostId, table.status, table.retryAt, table.sourceMessageId),
  check("inference_status", sql`
    (${table.status} = 'pending' AND ${table.retryAt} IS NOT NULL AND ${table.resolvedAt} IS NULL)
    OR (${table.status} IN ('observed', 'dropped', 'published') AND ${table.retryAt} IS NULL AND ${table.resolvedAt} IS NOT NULL)
  `),
  check("inference_delivery", sql`
    (${table.status} = 'published' AND ${table.ticketId} IS NOT NULL AND ${table.messageId} IS NOT NULL AND ${table.letterId} IS NOT NULL)
    OR (${table.status} <> 'published' AND ${table.ticketId} IS NULL AND ${table.messageId} IS NULL AND ${table.letterId} IS NULL)
  `),
]);

export const inferenceDailyReceipts = sqliteTable("inference_daily_receipts", {
  memberId: text("member_id").notNull().references(() => members.id),
  localDay: text("local_day").notNull(),
  sourceMessageId: text("source_message_id").notNull().references(() => inferenceCandidates.sourceMessageId),
}, (table) => [primaryKey({ columns: [table.memberId, table.localDay] })]);
