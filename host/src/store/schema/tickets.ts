import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { conversations, messages } from "./conversations.ts";
import { households, hosts, members } from "./identity.ts";

export const tickets = sqliteTable("tickets", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  forMemberId: text("for_member_id").notNull().references(() => members.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
  publicationEpoch: integer("publication_epoch"),
  kind: text("kind", { enum: ["followup", "errand"] }).notNull(),
  mandateKind: text("mandate_kind", { enum: ["explicit", "inferred"] }).notNull(),
  sourceMessageId: text("source_message_id").notNull().references(() => messages.id),
  sourceRevision: integer("source_revision").notNull(),
  goal: text("goal").notNull(),
  status: text("status", { enum: ["open", "ended"] }).notNull(),
  stage: text("stage", {
    enum: ["scheduled", "queued", "thinking", "waiting", "quiet_waiting", "completed", "failed", "blocked", "discarded", "cancelled"],
  }).notNull(),
  endedReason: text("ended_reason"),
  dueAt: integer("due_at"),
  timeZone: text("time_zone").notNull(),
}, (table) => [
  index("tickets_member_status").on(table.householdId, table.forMemberId, table.status, table.dueAt),
  index("tickets_host_admission").on(table.publisherHostId, table.kind, table.status, table.stage),
  check("tickets_due_at", sql`(${table.kind} = 'followup' AND ${table.dueAt} IS NOT NULL)
    OR (${table.kind} = 'errand' AND ${table.dueAt} IS NULL)`),
  check("tickets_source_revision", sql`${table.sourceRevision} > 0`),
  check("tickets_status_stage", sql`(${table.status} = 'open'
    AND ${table.stage} IN ('scheduled', 'queued', 'thinking', 'waiting', 'quiet_waiting') AND ${table.endedReason} IS NULL)
    OR (${table.status} = 'ended'
    AND ${table.stage} IN ('completed', 'failed', 'blocked', 'discarded', 'cancelled'))`),
]);

export const triggers = sqliteTable("triggers", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  actorMemberId: text("actor_member_id").notNull().references(() => members.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
  source: text("source", { enum: ["chat", "app"] }).notNull(),
  sourceMessageId: text("source_message_id").references(() => messages.id),
  sourceRevision: integer("source_revision"),
  idempotencyKey: text("idempotency_key").notNull(),
  commandKind: text("command_kind", { enum: ["schedule", "start", "reschedule", "append", "cancel"] }).notNull(),
  fingerprint: text("fingerprint").notNull(),
  receipt: text("receipt", { mode: "json" }).$type<{
    ticket_id: string;
    queued?: boolean;
    when?: string;
    time_zone?: string;
    saved?: true;
    resumed?: true;
    cancelled?: true;
  }>().notNull(),
}, (table) => [
  uniqueIndex("triggers_request_key").on(table.householdId, table.actorMemberId, table.source, table.idempotencyKey),
  check("triggers_source_proof", sql`(${table.sourceMessageId} IS NULL AND ${table.sourceRevision} IS NULL AND ${table.source} = 'app')
    OR (${table.sourceMessageId} IS NOT NULL AND ${table.sourceRevision} IS NOT NULL AND ${table.sourceRevision} > 0)`),
]);

export const decisions = sqliteTable("decisions", {
  ...businessColumns(),
  triggerId: text("trigger_id").notNull().references(() => triggers.id),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  outcome: text("outcome", { enum: ["accept", "attach"] }).notNull(),
  reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
}, (table) => [
  uniqueIndex("decisions_one_per_trigger").on(table.triggerId),
  index("decisions_ticket").on(table.ticketId),
]);

export const ticketInputs = sqliteTable("ticket_inputs", {
  ...businessColumns(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  triggerId: text("trigger_id").notNull().references(() => triggers.id),
  memberId: text("member_id").notNull().references(() => members.id),
  kind: text("kind", { enum: ["append", "reschedule"] }).notNull(),
  sourceMessageId: text("source_message_id").references(() => messages.id),
  sourceRevision: integer("source_revision"),
  text: text("text").notNull(),
}, (table) => [
  uniqueIndex("ticket_inputs_trigger").on(table.triggerId),
  index("ticket_inputs_ticket").on(table.ticketId, table.hlc, table.id),
  check("ticket_inputs_source_proof", sql`(${table.sourceMessageId} IS NULL AND ${table.sourceRevision} IS NULL)
    OR (${table.sourceMessageId} IS NOT NULL AND ${table.sourceRevision} IS NOT NULL AND ${table.sourceRevision} > 0)`),
]);

// 执行状态只属于发布宿主。下一切片以 runId、generation 和 ticket revision 复核作业。
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
  generation: integer("generation").notNull(),
  status: text("status", { enum: ["pending", "running", "ended"] }).notNull(),
  localDay: text("local_day"),
  outputTokens: integer("output_tokens").notNull().default(0),
  elapsedMs: integer("elapsed_ms").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("runs_ticket_generation").on(table.ticketId, table.generation),
  uniqueIndex("runs_ticket_running").on(table.ticketId).where(sql`${table.status} = 'running'`),
  index("runs_host_local_day").on(table.publisherHostId, table.localDay),
  check("runs_generation", sql`${table.generation} >= 0`),
  check("runs_budget", sql`${table.outputTokens} >= 0 AND ${table.elapsedMs} >= 0`),
  check("runs_status", sql`${table.status} IN ('pending', 'running', 'ended')`),
]);
