import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { households, hosts, members } from "./identity.ts";

export const conversations = sqliteTable("conversations", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  kind: text("kind", { enum: ["group", "direct"] }).notNull(),
  ownerMemberId: text("owner_member_id").references(() => members.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
}, (table) => [
  uniqueIndex("conversations_one_group").on(table.householdId).where(sql`${table.kind} = 'group'`),
  uniqueIndex("conversations_one_direct").on(table.ownerMemberId).where(sql`${table.kind} = 'direct'`),
  check("conversations_kind_owner", sql`(${table.kind} = 'group' AND ${table.ownerMemberId} IS NULL)
    OR (${table.kind} = 'direct' AND ${table.ownerMemberId} IS NOT NULL)`),
]);

export const participants = sqliteTable("participants", {
  ...businessColumns(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  memberId: text("member_id").notNull().references(() => members.id),
}, (table) => [uniqueIndex("participants_conversation_member").on(table.conversationId, table.memberId)]);

export const messages = sqliteTable("messages", {
  ...businessColumns(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  authorMemberId: text("author_member_id").references(() => members.id),
  text: text("text").notNull(),
  modality: text("modality", { enum: ["text"] }).notNull(),
  status: text("status", { enum: ["complete", "stopped"] }).notNull(),
  clientMessageId: text("client_message_id"),
  historyContextBlocked: integer("history_context_blocked", { mode: "boolean" }).notNull().default(false),
  replyToMessageId: text("reply_to_message_id").references((): AnySQLiteColumn => messages.id),
  turnId: text("turn_id"),
  publicationEpoch: integer("publication_epoch"),
}, (table) => [
  uniqueIndex("messages_client_idempotency").on(table.conversationId, table.authorMemberId, table.clientMessageId),
  index("messages_conversation_order").on(table.conversationId, table.hlc, table.id),
  check("messages_modality", sql`${table.modality} = 'text'`),
  check("messages_status", sql`${table.status} IN ('complete', 'stopped')`),
]);
