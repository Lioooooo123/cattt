import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { devices } from "./identity.ts";
import { pushOutbox } from "./publications.ts";

// 两张表随配对设备与本机 outbox 生命周期变化，不参与业务复制。
export const devicePushRegistrations = sqliteTable("device_push_registrations", {
  deviceId: text("device_id").primaryKey().references(() => devices.id),
  bindingId: text("binding_id").notNull(),
  token: text("token").notNull(),
  environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
  topic: text("topic").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("device_push_provider_token").on(table.environment, table.topic, table.token),
]);

export const pushDeliveries = sqliteTable("publication_push_deliveries", {
  notificationId: text("notification_id").notNull().references(() => pushOutbox.id),
  deviceId: text("device_id").notNull().references(() => devices.id),
  bindingId: text("binding_id").notNull(),
  apnsId: text("apns_id").notNull().unique(),
  status: text("status", { enum: ["pending", "sending", "sent", "dropped", "uncertain"] }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.notificationId, table.deviceId] }),
]);
