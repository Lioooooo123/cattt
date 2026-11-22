import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ToolMessage } from "../../llm/tool-loop.ts";
import type { SourceProof } from "../../tickets/types.ts";
import type { ConversationHead, WorkerDependency, WorkerResult } from "../../ticket-workers/types.ts";
import { conversations } from "./conversations.ts";
import { households, hosts, members } from "./identity.ts";
import { runs, tickets } from "./tickets.ts";

export const runSteps = sqliteTable("run_steps", {
  runId: text("run_id").notNull().references(() => runs.id),
  step: integer("step").notNull(),
  ticketRev: integer("ticket_rev").notNull(),
  history: text("history", { mode: "json" }).$type<ToolMessage[]>().notNull(),
  inputIds: text("input_ids", { mode: "json" }).$type<string[]>().notNull(),
  conversationHead: text("conversation_head", { mode: "json" }).$type<ConversationHead>().notNull(),
  dependencies: text("dependencies", { mode: "json" }).$type<WorkerDependency[]>().notNull(),
  usage: text("usage", { mode: "json" }).$type<{
    outputTokens: number; summaryTokens: number; toolValidationFailed: boolean;
  }>().notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.step] }),
  check("run_steps_position", sql`${table.step} BETWEEN 1 AND 20 AND ${table.ticketRev} > 0`),
]);

// 本机 Router 从持久报告恢复工作。可见发布的幂等回执属于 Router。
export const workerReports = sqliteTable("worker_reports", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  ticketRev: integer("ticket_rev").notNull(),
  resultTicketRev: integer("result_ticket_rev").notNull(),
  householdId: text("household_id").notNull().references(() => households.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  forMemberId: text("for_member_id").notNull().references(() => members.id),
  publisherHostId: text("publisher_host_id").notNull().references(() => hosts.id),
  kind: text("kind", { enum: ["errand", "followup"] }).notNull(),
  runId: text("run_id").references(() => runs.id),
  generation: integer("generation"),
  jobId: text("job_id").notNull(),
  jobAttempt: integer("job_attempt").notNull(),
  result: text("result", { mode: "json" }).$type<WorkerResult>().notNull(),
  sourceProofs: text("source_proofs", { mode: "json" }).$type<SourceProof[]>().notNull(),
  dependencies: text("dependencies", { mode: "json" }).$type<WorkerDependency[]>().notNull(),
  conversationHead: text("conversation_head", { mode: "json" }).$type<ConversationHead>().notNull(),
  dueAt: integer("due_at"),
  timeZone: text("time_zone").notNull(),
  quietAfter: integer("quiet_after"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("worker_reports_ticket_revision").on(table.ticketId, table.ticketRev),
  index("worker_reports_host_cursor").on(table.publisherHostId, table.sequence),
  check("worker_reports_kind_run", sql`(${table.kind} = 'followup' AND ${table.runId} IS NULL
    AND ${table.generation} IS NULL AND ${table.dueAt} IS NOT NULL)
    OR (${table.kind} = 'errand' AND ${table.runId} IS NOT NULL AND ${table.generation} IS NOT NULL AND ${table.generation} >= 0 AND ${table.dueAt} IS NULL)`),
  check("worker_reports_revision", sql`${table.ticketRev} > 0 AND ${table.resultTicketRev} = ${table.ticketRev} + 1
    AND ${table.jobAttempt} > 0`),
]);
