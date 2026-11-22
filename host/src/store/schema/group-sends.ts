import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { conversations } from "./conversations.ts";
import { households, members } from "./identity.ts";

export const groupSendIntents = sqliteTable("group_send_intents", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  memberId: text("member_id").notNull().references(() => members.id),
  clientMessageId: text("client_message_id").notNull(),
  text: text("text").notNull(),
  // Only the source host tracks delivery progress.
  status: text("status", { enum: ["pending", "accepted", "rejected"] }),
  deliveryId: text("delivery_id"),
}, (table) => [
  uniqueIndex("group_send_client_request").on(table.conversationId, table.memberId, table.clientMessageId),
  index("group_send_pending").on(table.originHostId, table.householdId).where(sql`${table.status} = 'pending'`),
]);
