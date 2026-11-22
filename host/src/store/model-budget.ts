import { and, count, eq, sum } from "drizzle-orm";
import { clockDate } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { ModelUsage } from "../llm/types.ts";
import type { StoreDb } from "./index.ts";
import { modelCalls } from "./schema/model-calls.ts";

type Reservation = Pick<typeof modelCalls.$inferInsert, "hostId" | "slot" | "purpose" | "provider" | "model" | "turnId" | "jobId" | "reservedTokens">;

export function reserveModelCall(db: StoreDb, clock: Clock, entry: Reservation, limits: { calls: number; tokens: number }): string | undefined {
  const date = clockDate(clock);
  const now = date.getTime();
  const day = date.toISOString().slice(0, 10);
  return db.transaction((tx) => {
    const spent = tx.select({ calls: count(), tokens: sum(modelCalls.reservedTokens) }).from(modelCalls)
      .where(and(eq(modelCalls.hostId, entry.hostId), eq(modelCalls.day, day))).get();
    if (spent && (spent.calls >= limits.calls || Number(spent.tokens ?? 0) + entry.reservedTokens > limits.tokens)) {
      return;
    }
    const id = uuidv7(clock);
    tx.insert(modelCalls).values({ ...entry, id, day, status: "reserved", createdAt: now }).run();
    return id;
  }, { behavior: "immediate" });
}

export function settleModelCall(db: StoreDb, id: string, status: "completed" | "failed", latencyMs: number, usage?: ModelUsage): void {
  db.update(modelCalls).set({ status, latencyMs, ...usage }).where(and(
    eq(modelCalls.id, id), eq(modelCalls.status, "reserved"),
  )).run();
}
