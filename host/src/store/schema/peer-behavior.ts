import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const peerOutbox = sqliteTable("peer_outbox", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  targetHostId: text("target_host_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  envelope: text("envelope").notNull(),
  jobId: text("job_id").notNull(),
  status: text("status", { enum: ["pending", "delivered", "rejected"] }).notNull(),
  receipt: text("receipt"),
  rejectionCode: text("rejection_code"),
  createdAt: integer("created_at").notNull(),
  settledAt: integer("settled_at"),
}, (table) => [
  uniqueIndex("peer_outbox_target_key").on(table.householdId, table.targetHostId, table.idempotencyKey),
  check("peer_outbox_state", sql`
    (${table.status} = 'pending' AND ${table.receipt} IS NULL AND ${table.settledAt} IS NULL)
    OR (${table.status} = 'delivered' AND ${table.receipt} IS NOT NULL AND ${table.settledAt} IS NOT NULL)
    OR (${table.status} = 'rejected' AND ${table.receipt} IS NULL AND ${table.settledAt} IS NOT NULL)`),
]);

export const peerInbox = sqliteTable("peer_inbox", {
  householdId: text("household_id").notNull(),
  sourceHostId: text("source_host_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  receipt: text("receipt").notNull(),
}, (table) => [primaryKey({ columns: [table.householdId, table.sourceHostId, table.idempotencyKey] })]);
