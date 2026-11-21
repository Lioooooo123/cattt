import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

function businessColumns() {
  return {
    id: text("id").primaryKey(),
    originHostId: text("origin_host_id").notNull(),
    hlc: text("hlc").notNull(),
    rev: integer("rev").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  };
}

export const households = sqliteTable("households", {
  ...businessColumns(),
  name: text("name").notNull(),
});

export const hosts = sqliteTable("hosts", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  displayName: text("display_name").notNull(),
});

export const members = sqliteTable("members", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  displayName: text("display_name").notNull(),
  homeHostId: text("home_host_id").notNull().references(() => hosts.id),
});

export const devices = sqliteTable("devices", {
  ...businessColumns(),
  memberId: text("member_id").notNull().references(() => members.id),
  hostId: text("host_id").notNull().references(() => hosts.id),
  name: text("name").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

export const deviceCredentials = sqliteTable("device_credentials", {
  deviceId: text("device_id").primaryKey().references(() => devices.id),
  tokenHash: text("token_hash").notNull().unique(),
});
