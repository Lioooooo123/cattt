import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { hosts } from "./identity.ts";

export const modelCalls = sqliteTable("model_calls", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull().references(() => hosts.id),
  day: text("day").notNull(),
  slot: text("slot", { enum: ["chat", "router", "worker", "extract"] }).notNull(),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  turnId: text("turn_id"),
  jobId: text("job_id"),
  reservedTokens: integer("reserved_tokens").notNull(),
  status: text("status", { enum: ["reserved", "completed", "failed"] }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("model_calls_host_day").on(table.hostId, table.day),
  check("model_calls_status", sql`${table.status} IN ('reserved', 'completed', 'failed')`),
  check("model_calls_reservation", sql`${table.reservedTokens} > 0`),
]);
