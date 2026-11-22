import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { members } from "./identity.ts";

export const memberResourceReceipts = sqliteTable("member_resource_receipts", {
  memberId: text("member_id").notNull().references(() => members.id),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  resourceId: text("resource_id").notNull(),
}, (table) => [primaryKey({ columns: [table.memberId, table.requestId] })]);
