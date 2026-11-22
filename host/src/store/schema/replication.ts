import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replicationState = sqliteTable("replication_state", {
  sourceHostId: text("source_host_id").primaryKey(),
  generation: text("generation").notNull(),
  lastSeq: integer("last_seq").notNull(),
  snapshotRequired: integer("snapshot_required", { mode: "boolean" }).notNull(),
});

export const changeLog = sqliteTable("change_log", {
  sourceHostId: text("source_host_id").notNull(),
  generation: text("generation").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  transactionEndSeq: integer("transaction_end_seq"),
}, (table) => [
  primaryKey({ columns: [table.sourceHostId, table.generation, table.seq] }),
]);

export const peerCursors = sqliteTable("peer_cursors", {
  sourceHostId: text("source_host_id").primaryKey(),
  householdId: text("household_id").notNull(),
  generation: text("generation").notNull(),
  seq: integer("seq").notNull(),
});

export const retiredPeerGenerations = sqliteTable("retired_peer_generations", {
  sourceHostId: text("source_host_id").notNull(),
  generation: text("generation").notNull(),
}, (table) => [primaryKey({ columns: [table.sourceHostId, table.generation] })]);
