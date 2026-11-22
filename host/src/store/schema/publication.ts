import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { households } from "./identity.ts";

// Epoch 1 is derived from the immutable household origin. Later epochs are
// control receipts, kept on both peers separately from business replication.
export const publicationEpochs = sqliteTable("publication_epochs", {
  householdId: text("household_id").notNull().references(() => households.id),
  epoch: integer("epoch").notNull(),
  grantId: text("grant_id").notNull(),
  holderHostId: text("holder_host_id").notNull(),
  previousHolderHostId: text("previous_holder_host_id").notNull(),
  previousGrantId: text("previous_grant_id").notNull(),
  historyDigest: text("history_digest").notNull(),
  acknowledged: integer("acknowledged", { mode: "boolean" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.epoch] }),
  uniqueIndex("publication_grant_id").on(table.householdId, table.grantId),
]);

export const publicationRenewals = sqliteTable("publication_renewals", {
  householdId: text("household_id").notNull().references(() => households.id),
  epoch: integer("epoch").notNull(),
  sequence: integer("sequence").notNull(),
  requestId: text("request_id").notNull(),
}, (table) => [primaryKey({ columns: [table.householdId, table.epoch] })]);
