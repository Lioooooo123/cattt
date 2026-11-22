import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";

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

export const pairingCodes = sqliteTable("pairing_codes", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  codeHash: text("code_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  failures: integer("failures").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const memberInvites = sqliteTable("member_invites", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id),
  displayName: text("display_name"),
  codeHash: text("code_hash").notNull(),
  invitedByMemberId: text("invited_by_member_id").references(() => members.id),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  revokedAt: integer("revoked_at"),
  failures: integer("failures").notNull(),
  createdAt: integer("created_at").notNull(),
  seatMemberId: text("seat_member_id"),
});

// Only the household creator writes these grants. They are not replication records.
export const memberSeatGrants = sqliteTable("member_seat_grants", {
  memberId: text("member_id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id),
  peerHostId: text("peer_host_id").notNull(),
  expiresAt: integer("expires_at"),
  confirmedAt: integer("confirmed_at"),
  releasedAt: integer("released_at"),
});

export const memberSeatLegacyPeers = sqliteTable("member_seat_legacy_peers", {
  peerHostId: text("peer_host_id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id),
});
