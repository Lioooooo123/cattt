import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { messages } from "./conversations.ts";
import { households, members } from "./identity.ts";

export const diaryEntries = sqliteTable("diary_entries", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  ownerMemberId: text("owner_member_id").notNull().references(() => members.id),
  sourceMemberId: text("source_member_id").notNull().references(() => members.id),
  sourceMessageId: text("source_message_id").references(() => messages.id),
  sourceRevision: integer("source_revision"),
  text: text("text").notNull(),
  recordedAt: integer("recorded_at").notNull(),
  localDay: text("local_day").notNull(),
  timeZone: text("time_zone").notNull(),
  catAllowed: integer("cat_allowed", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  index("diary_entries_household_owner_day").on(table.householdId, table.ownerMemberId, table.localDay),
  index("diary_entries_household_source_message").on(table.householdId, table.sourceMessageId),
  check("diary_entries_source_revision", sql`
    (${table.sourceMessageId} IS NULL AND ${table.sourceRevision} IS NULL)
    OR (${table.sourceMessageId} IS NOT NULL AND ${table.sourceRevision} IS NOT NULL AND ${table.sourceRevision} > 0)
  `),
]);
