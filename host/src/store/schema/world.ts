import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { devices, households, members } from "./identity.ts";

export const worldCats = sqliteTable("world_cats", {
  ...businessColumns(),
  householdId: text("household_id").notNull().unique().references(() => households.id),
  legacyId: text("legacy_id").unique(),
  epoch: integer("epoch").notNull(),
  grantId: text("grant_id").notNull(),
});

export const worldStates = sqliteTable("world_states", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  catId: text("cat_id").notNull().references(() => worldCats.id),
  epoch: integer("epoch").notNull(),
  grantId: text("grant_id").notNull(),
  profile: text("profile", { mode: "json" }).notNull(),
  snapshot: text("snapshot", { mode: "json" }),
  observedAt: integer("observed_at"),
}, (table) => [uniqueIndex("world_state_publication").on(table.householdId, table.epoch)]);

export const worldActions = sqliteTable("world_actions", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  catId: text("cat_id").notNull().references(() => worldCats.id),
  epoch: integer("epoch").notNull(),
  grantId: text("grant_id").notNull(),
  memberId: text("member_id").notNull().references(() => members.id),
  requestId: text("request_id").notNull(),
  destinationId: text("destination_id").notNull(),
  activity: text("activity"),
  stateVersion: integer("state_version").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  acceptBefore: integer("accept_before").notNull(),
  finishBefore: integer("finish_before").notNull(),
  resultSnapshot: text("result_snapshot", { mode: "json" }),
  occurredAt: integer("occurred_at"),
}, (table) => [
  uniqueIndex("world_action_request").on(table.householdId, table.memberId, table.requestId),
  index("world_action_publication").on(table.householdId, table.epoch, table.status),
]);

// 本机的会话与执行绑定在每次启动时清空，绝不进入业务日志。
export const worldSessions = sqliteTable("world_sessions", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  deviceId: text("device_id").notNull().references(() => devices.id),
  generation: text("generation").notNull(),
  presentUntil: integer("present_until").notNull(),
  streamUntil: integer("stream_until").notNull(),
  driveGrantId: text("drive_grant_id"),
  snapshot: text("snapshot", { mode: "json" }),
  stateVersion: integer("state_version").notNull(),
  observedAt: integer("observed_at"),
}, (table) => [index("world_sessions_household").on(table.householdId)]);

export const worldExecutors = sqliteTable("world_executors", {
  actionId: text("action_id").primaryKey().references(() => worldActions.id),
  sessionId: text("session_id").notNull(),
}, (table) => [index("world_executor_session").on(table.sessionId)]);
