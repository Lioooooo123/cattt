import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export { deviceCredentials, devices, households, hosts, memberInvites, members, pairingCodes } from "./identity.ts";
export { conversations, messages, participants } from "./conversations.ts";
export { diaryEntries } from "./diary.ts";
export { boundaries, knowledgeSourceWithdrawals, memories, memoryBlocks } from "./knowledge.ts";
export { chatReplyKnowledge, memoryExtractionDependencies, pendingMemoryExtractions } from "./memory-extraction.ts";
export { memberChangeProjections } from "./member-changes.ts";
export { memberResourceReceipts } from "./member-resources.ts";
export { turns } from "./turns.ts";
export { peers } from "./peers.ts";
export { changeLog, peerCursors, replicationState, retiredPeerGenerations } from "./replication.ts";
export { fileBlobs, fileDescriptions, files, fileUploads } from "./files.ts";

export const chatEvents = sqliteTable("chat_events", {
  streamId: text("stream_id").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  data: text("data").notNull(),
  terminal: integer("terminal", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.streamId, table.seq] }),
  index("chat_events_created_at").on(table.createdAt),
]);

export const hostMeta = sqliteTable("host_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const leases = sqliteTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  epoch: integer("epoch").notNull(),
  acquiredHlc: text("acquired_hlc").notNull(),
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  queue: text("queue").notNull(),
  payload: text("payload").notNull(),
  status: text("status", { enum: ["queued", "running", "done", "dead"] }).notNull(),
  attempts: integer("attempts").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  runAt: integer("run_at").notNull(),
  lockedUntil: integer("locked_until"),
  dedupeKey: text("dedupe_key"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("jobs_active_dedupe").on(table.queue, table.dedupeKey)
    .where(sql`${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('queued', 'running')`),
  index("jobs_claim").on(table.queue, table.status, table.runAt),
  check("jobs_status", sql`${table.status} IN ('queued', 'running', 'done', 'dead')`),
]);

export { decisions, runs, ticketInputs, tickets, triggers } from "./tickets.ts";
export { runSteps, workerReports } from "./ticket-worker.ts";
export { mailboxLetters, mailboxReads, publicationReceipts, pushOutbox, ticketPublications } from "./publications.ts";
export { inferenceCandidates, inferenceDailyReceipts, proactivePermissions } from "./inference.ts";

export { peerInbox, peerOutbox } from "./peer-behavior.ts";
export { relayGrants, relayPublications } from "./relay.ts";

export * from "./publication.ts";
export * from "./group-sends.ts";
export * from "./pg-import.ts";
export * from "./push.ts";
export { modelCalls } from "./model-calls.ts";
export * from "./world.ts";
export * from "./cat-facts.ts";
