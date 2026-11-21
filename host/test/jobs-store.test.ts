import { afterEach, expect, test } from "bun:test";
import { ManualClock } from "../src/clock/index.ts";
import { openStore } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { claimJob, completeJob, enqueueJob, failJob, getJob } from "../src/store/jobs.ts";
import { jobs } from "../src/store/schema/index.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  return { db: store.db, clock: new ManualClock("test", 100) };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("入队、按到期时间领取与完成，所有时间来自 Clock", () => {
  const { db, clock } = setup();
  expect(claimJob(db, clock, "test", 100)).toBeUndefined();
  const later = enqueueJob(db, clock, { queue: "test", payload: { value: 2 }, runAt: 200 });
  const earlier = enqueueJob(db, clock, { queue: "test", payload: { value: 1 } });
  expect(getJob(db, earlier)).toMatchObject({
    status: "queued", attempts: 0, createdAt: 100, updatedAt: 100, lockedUntil: null,
  });
  const attempt = claimJob(db, clock, "test", 50)!;
  expect(attempt.id).toBe(earlier);
  expect(JSON.parse(attempt.payload)).toEqual({ value: 1 });
  expect(attempt).toMatchObject({ status: "running", attempts: 1, lockedUntil: 150 });
  expect(completeJob(db, clock, attempt)).toBe(true);
  expect(completeJob(db, clock, attempt)).toBe(false);
  expect(getJob(db, earlier)).toMatchObject({ status: "done", lockedUntil: null });
  expect(claimJob(db, clock, "test", 50)).toBeUndefined();
  clock.setWallMs(200);
  expect(claimJob(db, clock, "test", 50)?.id).toBe(later);
});

test("活跃去重按队列隔离，完成或死亡后可重新入队，空键也去重", () => {
  const { db, clock } = setup();
  const input = { queue: "a", payload: null, dedupeKey: "" };
  const id = enqueueJob(db, clock, input);
  expect(enqueueJob(db, clock, input)).toBe(id);
  expect(enqueueJob(db, clock, { ...input, queue: "b" })).not.toBe(id);
  const attempt = claimJob(db, clock, "a", 100)!;
  expect(enqueueJob(db, clock, input)).toBe(id);
  completeJob(db, clock, attempt);
  const next = enqueueJob(db, clock, input);
  expect(next).not.toBe(id);
  const failed = claimJob(db, clock, "a", 100)!;
  failJob(db, clock, failed, "无效负载", 100, true);
  expect(enqueueJob(db, clock, input)).not.toBe(next);
  expect(enqueueJob(db, clock, { queue: "a", payload: null }))
    .not.toBe(enqueueJob(db, clock, { queue: "a", payload: null }));
});

test("失败按指定时间重试，耗尽次数进入 dead", () => {
  const { db, clock } = setup();
  const id = enqueueJob(db, clock, { queue: "a", payload: [], maxAttempts: 2 });
  const first = claimJob(db, clock, "a", 100)!;
  expect(failJob(db, clock, first, new Error("失败"), 200)).toBe(true);
  expect(getJob(db, id)).toMatchObject({ status: "queued", runAt: 200, lastError: "Error: 失败" });
  expect(claimJob(db, clock, "a", 100)).toBeUndefined();
  clock.setWallMs(200);
  const second = claimJob(db, clock, "a", 100)!;
  expect(second.attempts).toBe(2);
  failJob(db, clock, second, "再次失败", 300);
  expect(getJob(db, id)).toMatchObject({ status: "dead", attempts: 2 });
  clock.setWallMs(300);
  expect(claimJob(db, clock, "a", 100)).toBeUndefined();
});

test("SQLite 部分唯一索引只约束活跃的非空去重键", () => {
  const { db, clock } = setup();
  const id = enqueueJob(db, clock, { queue: "a", payload: null, dedupeKey: "key" });
  const original = getJob(db, id)!;
  expect(() => db.insert(jobs).values({ ...original, id: "duplicate" }).run()).toThrow();
  completeJob(db, clock, claimJob(db, clock, "a", 100)!);
  expect(() => db.insert(jobs).values({ ...original, id: "after-done" }).run()).not.toThrow();
});

test("租期到期重领递增尝试次数，旧完成与失败都被拒绝", () => {
  const { db, clock } = setup();
  const id = enqueueJob(db, clock, { queue: "a", payload: {} });
  const first = claimJob(db, clock, "a", 50)!;
  clock.setWallMs(150);
  expect(completeJob(db, clock, first)).toBe(false);
  const second = claimJob(db, clock, "a", 50)!;
  expect(second).toMatchObject({ id, attempts: 2, lockedUntil: 200 });
  expect(completeJob(db, clock, first)).toBe(false);
  expect(failJob(db, clock, first, "僵尸", 160)).toBe(false);
  expect(getJob(db, id)?.status).toBe("running");
  expect(completeJob(db, clock, second)).toBe(true);
});

test("最后一次租期到期标死，并继续领取后面的作业", () => {
  const { db, clock } = setup();
  const id = enqueueJob(db, clock, { queue: "a", payload: {}, maxAttempts: 1 });
  claimJob(db, clock, "a", 50);
  clock.setWallMs(150);
  const next = enqueueJob(db, clock, { queue: "a", payload: {} });
  expect(claimJob(db, clock, "a", 50)?.id).toBe(next);
  expect(getJob(db, id)).toMatchObject({ status: "dead", attempts: 1, lockedUntil: null });
});

test("无效负载、时间与次数配置拒绝入队", () => {
  const { db, clock } = setup();
  expect(() => enqueueJob(db, clock, { queue: "a", payload: undefined })).toThrow();
  expect(() => enqueueJob(db, clock, { queue: "a", payload: {}, maxAttempts: 0 })).toThrow();
  expect(() => enqueueJob(db, clock, { queue: "a", payload: {}, runAt: -1 })).toThrow();
  expect(() => claimJob(db, clock, "a", 0)).toThrow();
});
