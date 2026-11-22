import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { messages } from "./conversations.ts";
import { households, members } from "./identity.ts";

function sourceColumns() {
  return {
    householdId: text("household_id").notNull().references(() => households.id),
    sourceMemberId: text("source_member_id").notNull().references(() => members.id),
    sourceMessageId: text("source_message_id").notNull().references(() => messages.id),
    sourceRevision: integer("source_revision").notNull(),
  };
}

function provenanceColumns() {
  return {
    ...businessColumns(),
    ...sourceColumns(),
  };
}

export const knowledgeSourceWithdrawals = sqliteTable("knowledge_source_withdrawals", {
  ...businessColumns(),
  ...sourceColumns(),
}, (table) => [
  uniqueIndex("knowledge_source_withdrawals_message").on(table.sourceMessageId),
  check("knowledge_source_withdrawals_revision", sql`${table.sourceRevision} > 0`),
]);

export const memories = sqliteTable("memories", {
  ...provenanceColumns(),
  // NULL denotes the household itself. Individually attributed facts use a real member FK.
  subjectMemberId: text("subject_member_id").references(() => members.id),
  fingerprint: text("fingerprint").notNull(),
  predicate: text("predicate").notNull(),
  value: text("value").notNull(),
  correctsPrevious: integer("corrects_previous", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("memories_source_fact").on(table.sourceMessageId, table.sourceRevision, table.subjectMemberId, table.fingerprint),
  uniqueIndex("memories_source_household_fact").on(table.sourceMessageId, table.sourceRevision, table.fingerprint)
    .where(sql`${table.subjectMemberId} IS NULL`),
  index("memories_household_subject").on(table.householdId, table.subjectMemberId),
  index("memories_household_source_member").on(table.householdId, table.sourceMemberId),
  check("memories_source_revision", sql`${table.sourceRevision} > 0`),
]);

export const memoryBlocks = sqliteTable("memory_blocks", {
  ...provenanceColumns(),
  subjectMemberId: text("subject_member_id").references(() => members.id),
  fingerprint: text("fingerprint").notNull(),
}, (table) => [
  uniqueIndex("memory_blocks_source_fact").on(table.sourceMessageId, table.sourceRevision, table.subjectMemberId, table.fingerprint),
  uniqueIndex("memory_blocks_source_household_fact").on(table.sourceMessageId, table.sourceRevision, table.fingerprint)
    .where(sql`${table.subjectMemberId} IS NULL`),
  index("memory_blocks_household_subject_fact").on(table.householdId, table.subjectMemberId, table.fingerprint),
  check("memory_blocks_source_revision", sql`${table.sourceRevision} > 0`),
]);

export const boundaries = sqliteTable("boundaries", {
  ...provenanceColumns(),
  subjectMemberId: text("subject_member_id").notNull().references(() => members.id),
  description: text("description").notNull(),
}, (table) => [
  uniqueIndex("boundaries_source_subject").on(table.sourceMessageId, table.sourceRevision, table.subjectMemberId),
  index("boundaries_household_subject").on(table.householdId, table.subjectMemberId),
  index("boundaries_household_source_member").on(table.householdId, table.sourceMemberId),
  check("boundaries_source_revision", sql`${table.sourceRevision} > 0`),
]);
