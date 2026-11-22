import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { households, members } from "./identity.ts";

/** Local audit evidence. Neither table participates in replication. */
export const pgImportReceipts = sqliteTable("pg_import_receipts", {
  id: integer("id").primaryKey(),
  sourceSha256: text("source_sha256").notNull(),
  report: text("report", { mode: "json" }).$type<unknown>().notNull(),
});

export const pgImportArchive = sqliteTable("pg_import_archive", {
  sourceTable: text("source_table").notNull(),
  sourceKey: text("source_key").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  targetId: text("target_id"),
  reason: text("reason").notNull(),
  evidenceJson: text("evidence_json").notNull(),
}, (table) => [primaryKey({ columns: [table.sourceTable, table.sourceKey] })]);

/** Historical cat authorship has no member-authored personal diary counterpart. */
export const importedCatDiary = sqliteTable("imported_cat_diary", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  ownerMemberId: text("owner_member_id").notNull().references(() => members.id),
  text: text("text").notNull(),
  recordedAt: integer("recorded_at").notNull(),
  localDay: text("local_day").notNull(),
  timeZone: text("time_zone").notNull(),
});

export const importedMemoryRestrictions = sqliteTable("imported_memory_restrictions", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  learningDisabled: integer("learning_disabled", { mode: "boolean" }).notNull(),
  recallDisabled: integer("recall_disabled", { mode: "boolean" }).notNull(),
});

export const importedMemoryBlocks = sqliteTable("imported_memory_blocks", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  memberId: text("member_id").notNull().references(() => members.id),
  fingerprint: text("fingerprint").notNull(),
}, (table) => [uniqueIndex("imported_memory_block_identity").on(table.memberId, table.fingerprint)]);
