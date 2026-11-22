import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { conversations, messages } from "./conversations.ts";
import { households, hosts, members } from "./identity.ts";
import { workerReports } from "./ticket-worker.ts";
import { tickets } from "./tickets.ts";

export const mailboxLetters = sqliteTable("mailbox_letters", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  forMemberId: text("for_member_id").notNull().references(() => members.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  text: text("text").notNull(),
  createdHlc: text("created_hlc").notNull(),
  readAt: integer("read_at"),
}, (table) => [
  index("mailbox_member_order").on(table.householdId, table.forMemberId, table.createdHlc, table.id),
]);

// pending 是本机待办，终态行是同一报告的唯一收据。
export const publicationReceipts = sqliteTable("publication_receipts", {
  reportId: text("report_id").primaryKey().references(() => workerReports.id),
  hostId: text("host_id").notNull().references(() => hosts.id),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  status: text("status", { enum: ["pending", "published", "dropped"] }).notNull(),
  retryAt: integer("retry_at"),
  reason: text("reason"),
  messageId: text("message_id").references(() => messages.id),
  letterId: text("letter_id").references(() => mailboxLetters.id),
  resolvedAt: integer("resolved_at"),
}, (table) => [
  index("publication_receipts_ready").on(table.hostId, table.status, table.retryAt, table.reportId),
  check("publication_receipt_status", sql`
    (${table.status} = 'pending' AND ${table.retryAt} IS NOT NULL AND ${table.resolvedAt} IS NULL
      AND ${table.messageId} IS NULL AND ${table.letterId} IS NULL)
    OR (${table.status} = 'dropped' AND ${table.retryAt} IS NULL AND ${table.resolvedAt} IS NOT NULL
      AND ${table.reason} IS NOT NULL AND ${table.messageId} IS NULL AND ${table.letterId} IS NULL)
    OR (${table.status} = 'published' AND ${table.retryAt} IS NULL AND ${table.resolvedAt} IS NOT NULL
      AND (${table.messageId} IS NOT NULL OR ${table.letterId} IS NOT NULL))`),
]);

export const pushOutbox = sqliteTable("publication_push_outbox", {
  id: text("id").primaryKey(),
  reportId: text("report_id").notNull().unique().references(() => publicationReceipts.reportId),
  hostId: text("host_id").notNull().references(() => hosts.id),
  memberId: text("member_id").notNull().references(() => members.id),
  status: text("status", { enum: ["pending", "sending", "sent", "dropped", "uncertain"] }).notNull(),
  retryAt: integer("retry_at").notNull(),
  budgetDay: text("budget_day"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("publication_push_ready").on(table.hostId, table.status, table.retryAt, table.id),
  index("publication_push_member_day").on(table.memberId, table.budgetDay),
]);

// Read acknowledgement is an original fact of the receiving member's home.
export const mailboxReads = sqliteTable("mailbox_reads", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  letterId: text("letter_id").notNull().unique().references(() => mailboxLetters.id),
  memberId: text("member_id").notNull().references(() => members.id),
  readAt: integer("read_at").notNull(),
});

// Business evidence links committed content to its mandate without a local run/report foreign key.
export const ticketPublications = sqliteTable("ticket_publications", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  ticketRev: integer("ticket_rev").notNull(),
  kind: text("kind", { enum: ["worker", "inference"] }).notNull(),
  messageId: text("message_id").unique().references(() => messages.id),
  letterId: text("letter_id").unique().references(() => mailboxLetters.id),
  audienceDays: text("audience_days", { mode: "json" }).$type<{ memberId: string; localDay: string }[]>().notNull(),
}, (table) => [
  index("ticket_publications_ticket").on(table.ticketId),
  check("ticket_publication_content", sql`${table.messageId} IS NOT NULL OR ${table.letterId} IS NOT NULL`),
]);
