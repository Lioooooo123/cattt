import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 本机设备投影索引。只保存指纹，不存可见内容的历史副本。 */
export const memberChangeProjections = sqliteTable("member_change_projections", {
  householdId: text("household_id").notNull(),
  memberId: text("member_id").notNull(),
  generation: text("generation").notNull(),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
  sequence: integer("sequence").notNull(),
  fingerprint: text("fingerprint"),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.memberId, table.kind, table.resourceId] }),
  uniqueIndex("member_change_sequence").on(table.householdId, table.memberId, table.sequence),
]);
