import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { households } from "./identity.ts";

// Approval is local trust state. A candidate may not have a replicated hosts row yet.
export const peers = sqliteTable("peers", {
  hostId: text("host_id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id),
  joinFromHouseholdId: text("join_from_household_id"),
  joinPreparedAt: integer("join_prepared_at"),
  addressHost: text("address_host").notNull(),
  addressPort: integer("address_port").notNull(),
  caCertificate: text("ca_certificate").notNull(),
  fingerprint: text("fingerprint").notNull().unique(),
  protocolVersion: integer("protocol_version").notNull(),
  approvedAt: integer("approved_at").notNull(),
  approvalId: text("approval_id"),
  confirmedAt: integer("confirmed_at"),
  confirmedLocalFingerprint: text("confirmed_local_fingerprint"),
  revokedAt: integer("revoked_at"),
  pullPaused: integer("pull_paused", { mode: "boolean" }).notNull().default(false),
});
