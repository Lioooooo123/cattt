import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { messages } from "./conversations.ts";
import { households, hosts, members } from "./identity.ts";

/** Original, immutable authorization and quota reservation on the source member's home. */
export const relayGrants = sqliteTable("relay_grants", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  sourceMemberId: text("source_member_id").notNull().references(() => members.id),
  sourceMessageId: text("source_message_id").notNull().references(() => messages.id),
  sourceRevision: integer("source_revision").notNull(),
  targetMemberId: text("target_member_id").notNull().references(() => members.id),
  targetHostId: text("target_host_id").notNull().references(() => hosts.id),
  sourceGeneration: text("source_generation").notNull(),
  sourceSeq: integer("source_seq").notNull(),
  sourceDay: text("source_day").notNull(),
  sourceTimeZone: text("source_time_zone").notNull(),
  urgent: integer("urgent", { mode: "boolean" }).notNull(),
}, (table) => [
  uniqueIndex("relay_grants_original").on(table.sourceMessageId),
  index("relay_grants_quota").on(table.sourceMemberId, table.sourceDay, table.urgent),
  check("relay_grants_proof", sql`${table.sourceMemberId} <> ${table.targetMemberId}
    AND ${table.sourceRevision} > 0 AND ${table.sourceSeq} > 0 AND ${table.rev} = 1 AND ${table.deletedAt} IS NULL`),
]);

/** Execution and publication result exist only on the target home. */
export const relayPublications = sqliteTable("relay_publications", {
  grantId: text("grant_id").primaryKey().references(() => relayGrants.id),
  targetHostId: text("target_host_id").notNull().references(() => hosts.id),
  state: text("state", { enum: ["pending", "published", "dropped"] }).notNull(),
  reason: text("reason"),
  retryAt: integer("retry_at"),
  messageId: text("message_id").references(() => messages.id),
}, (table) => [
  index("relay_publications_due").on(table.targetHostId, table.state, table.retryAt),
  uniqueIndex("relay_publications_message").on(table.messageId),
  check("relay_publications_state", sql`
    (${table.state} = 'pending' AND ${table.retryAt} IS NOT NULL AND ${table.messageId} IS NULL)
    OR (${table.state} = 'published' AND ${table.retryAt} IS NULL AND ${table.messageId} IS NOT NULL)
    OR (${table.state} = 'dropped' AND ${table.retryAt} IS NULL AND ${table.messageId} IS NULL)`),
]);
