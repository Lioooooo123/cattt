import { afterEach, expect, test } from "bun:test";
import { ManualClock, parseHlc } from "../src/clock/index.ts";
import { getHostMeta, setHostMeta } from "../src/store/host-meta.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import {
  acquireLease,
  assertLeaseHeld,
  DEFAULT_LEASE_SKEW_MS,
  getLease,
  LeaseLostError,
  releaseLease,
  renewLease,
} from "../src/store/leases.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  return { store, db: store.db, clock: new ManualClock("test", 100) };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("空租约可获取，活跃持有者阻止竞争，同持有者续租不改变 epoch 或取得 HLC", () => {
  const { db, clock } = setup();
  expect(getLease(db, "chat")).toBeUndefined();
  const first = acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 });
  expect(first).toEqual({ acquired: true, holder: "a", epoch: 1, expiresAt: 200 });
  const acquiredHlc = getLease(db, "chat")!.acquiredHlc;
  expect(parseHlc(acquiredHlc)).toEqual({ physicalMs: 100, logical: 0, nodeId: "test" });
  expect(acquireLease(db, clock, { name: "chat", holder: "b", ttlMs: 100 }))
    .toEqual({ ...first, acquired: false });
  clock.advance(50);
  expect(acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 }))
    .toEqual({ acquired: true, holder: "a", epoch: 1, expiresAt: 250 });
  expect(getLease(db, "chat")).toMatchObject({ acquiredHlc, updatedAt: 150 });
});

test("接管必须严格超过到期加时钟宽限，接管递增 epoch 并重签 HLC", () => {
  const { db, clock } = setup();
  acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 });
  clock.setWallMs(200);
  expect(acquireLease(db, clock, { name: "chat", holder: "b", ttlMs: 100 }).acquired).toBe(false);
  clock.setWallMs(200 + DEFAULT_LEASE_SKEW_MS);
  expect(acquireLease(db, clock, { name: "chat", holder: "b", ttlMs: 100 }).acquired).toBe(false);
  clock.advance(1);
  const second = acquireLease(db, clock, { name: "chat", holder: "b", ttlMs: 100 });
  expect(second).toMatchObject({ acquired: true, holder: "b", epoch: 2 });
  expect(parseHlc(getLease(db, "chat")!.acquiredHlc).physicalMs).toBe(clock.wallMs());
  expect(renewLease(db, clock, "chat", "a", 1, 100)).toBe(false);
  expect(renewLease(db, clock, "chat", "b", 1, 100)).toBe(false);
  expect(releaseLease(db, clock, "chat", "a", 1)).toBe(false);
});

test("续租只允许未到期且 holder 和 epoch 都匹配的持有者", () => {
  const { db, clock } = setup();
  acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 });
  clock.setWallMs(150);
  expect(renewLease(db, clock, "chat", "a", 1, 100)).toBe(true);
  expect(getLease(db, "chat")!.expiresAt).toBe(250);
  clock.setWallMs(250);
  expect(renewLease(db, clock, "chat", "a", 1, 100)).toBe(false);
  expect(() => assertLeaseHeld(db, clock, "chat", "a", 1)).toThrow(LeaseLostError);
  expect(acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 }).epoch).toBe(1);
});

test("释放保留 fencing 历史，同持有者也必须以新 epoch 重新获取", () => {
  const { db, clock } = setup();
  acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 });
  expect(releaseLease(db, clock, "chat", "a", 1)).toBe(true);
  expect(getLease(db, "chat")).toMatchObject({ epoch: 1, expiresAt: 0 });
  expect(releaseLease(db, clock, "chat", "a", 1)).toBe(false);
  const second = acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 100 });
  expect(second).toMatchObject({ acquired: true, epoch: 2 });
  expect(renewLease(db, clock, "chat", "a", 1, 100)).toBe(false);
  expect(releaseLease(db, clock, "chat", "a", 1)).toBe(false);
  expect(() => assertLeaseHeld(db, clock, "chat", "a", 1)).toThrow(LeaseLostError);
});

test("调用方写事务中的 fencing 失败回滚全部写入", () => {
  const { db, clock, store } = setup();
  acquireLease(db, clock, { name: "chat", holder: "a", ttlMs: 10 });
  clock.setWallMs(111);
  acquireLease(db, clock, { name: "chat", holder: "b", ttlMs: 100, skewMs: 0 });
  expect(() => writeTransaction(store, (tx) => {
    setHostMeta(tx, "result", "僵尸写入");
    assertLeaseHeld(tx, clock, "chat", "a", 1);
  })).toThrow(LeaseLostError);
  expect(getHostMeta(db, "result")).toBeUndefined();
  writeTransaction(store, (tx) => {
    assertLeaseHeld(tx, clock, "chat", "b", 2);
    setHostMeta(tx, "result", "新持有者写入");
  });
  expect(getHostMeta(db, "result")).toBe("新持有者写入");
});

test("拒绝空名称、负宽限、无效租期，缺失租约不能续租或释放", () => {
  const { db, clock } = setup();
  expect(renewLease(db, clock, "missing", "a", 1, 100)).toBe(false);
  expect(releaseLease(db, clock, "missing", "a", 1)).toBe(false);
  expect(() => assertLeaseHeld(db, clock, "missing", "a", 1)).toThrow(LeaseLostError);
  for (const input of [
    { name: "", holder: "a", ttlMs: 100 },
    { name: "chat", holder: "", ttlMs: 100 },
    { name: "chat", holder: "a", ttlMs: 0 },
    { name: "chat", holder: "a", ttlMs: 100, skewMs: -1 },
  ]) {
    expect(() => acquireLease(db, clock, input)).toThrow();
  }
});
