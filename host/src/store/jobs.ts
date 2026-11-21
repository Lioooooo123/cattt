import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";
import type { StoreDb } from "./index.ts";
import { jobs } from "./schema/index.ts";

export interface EnqueueJob {
  queue: string;
  payload: unknown;
  runAt?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

export type Job = typeof jobs.$inferSelect;
export type JobAttempt = Pick<Job, "id" | "attempts">;

export function enqueueJob(db: StoreDb, clock: Clock, input: EnqueueJob): string {
  const now = clock.wallMs();
  const runAt = input.runAt ?? now;
  validateWallMs(now);
  validateWallMs(runAt);
  const maxAttempts = input.maxAttempts ?? 3;
  if (!input.queue || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("队列名不能为空，最大尝试次数必须是正整数");
  }
  const payload = JSON.stringify(input.payload);
  if (payload === undefined) {
    throw new TypeError("作业负载必须可编码为 JSON");
  }
  return db.transaction((tx) => {
    if (input.dedupeKey !== undefined) {
      const existing = tx.select().from(jobs).where(and(
        eq(jobs.queue, input.queue),
        eq(jobs.dedupeKey, input.dedupeKey),
        inArray(jobs.status, ["queued", "running"]),
      )).get();
      if (existing) {
        return existing.id;
      }
    }
    const id = uuidv7(clock);
    tx.insert(jobs).values({
      id,
      queue: input.queue,
      payload,
      status: "queued",
      attempts: 0,
      maxAttempts,
      runAt,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }, { behavior: "immediate" });
}

export function claimJob(db: StoreDb, clock: Clock, queue: string, timeoutMs: number): Job | undefined {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("租期必须是正整数毫秒");
  }
  return db.transaction((tx) => {
    const now = clock.wallMs();
    validateWallMs(now);
    validateWallMs(now + timeoutMs);
    while (true) {
      const job = tx.select().from(jobs).where(and(
        eq(jobs.queue, queue),
        or(
          and(eq(jobs.status, "queued"), lte(jobs.runAt, now)),
          and(eq(jobs.status, "running"), lte(jobs.lockedUntil, now)),
        ),
      )).orderBy(asc(jobs.runAt), asc(jobs.id)).limit(1).get();
      if (!job) {
        return undefined;
      }
      if (job.attempts >= job.maxAttempts) {
        tx.update(jobs).set({
          status: "dead",
          lockedUntil: null,
          lastError: "尝试次数耗尽，租期已过",
          updatedAt: now,
        }).where(eq(jobs.id, job.id)).run();
        continue;
      }
      return tx.update(jobs).set({
        status: "running",
        attempts: job.attempts + 1,
        lockedUntil: now + timeoutMs,
        updatedAt: now,
      }).where(eq(jobs.id, job.id)).returning().get();
    }
  }, { behavior: "immediate" });
}

function held(attempt: JobAttempt, now: number) {
  return and(
    eq(jobs.id, attempt.id),
    eq(jobs.attempts, attempt.attempts),
    eq(jobs.status, "running"),
    gt(jobs.lockedUntil, now),
  );
}

export function completeJob(db: StoreDb, clock: Clock, attempt: JobAttempt): boolean {
  return db.transaction((tx) => {
    const now = clock.wallMs();
    validateWallMs(now);
    return tx.update(jobs).set({
      status: "done",
      lockedUntil: null,
      lastError: null,
      updatedAt: now,
    }).where(held(attempt, now)).returning({ id: jobs.id }).get() !== undefined;
  }, { behavior: "immediate" });
}

export function failJob(
  db: StoreDb,
  clock: Clock,
  attempt: JobAttempt,
  error: unknown,
  retryAt: number,
  permanent = false,
): boolean {
  validateWallMs(retryAt);
  return db.transaction((tx) => {
    const now = clock.wallMs();
    validateWallMs(now);
    const job = tx.select().from(jobs).where(held(attempt, now)).get();
    if (!job) {
      return false;
    }
    return tx.update(jobs).set({
      status: permanent || job.attempts >= job.maxAttempts ? "dead" : "queued",
      runAt: retryAt,
      lockedUntil: null,
      lastError: String(error).slice(0, 2000),
      updatedAt: now,
    }).where(held(attempt, now)).returning({ id: jobs.id }).get() !== undefined;
  }, { behavior: "immediate" });
}

export function getJob(db: StoreDb, id: string): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}
