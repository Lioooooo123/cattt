import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ManualClock } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { createMember, ensureHousehold, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { issuePairingCode, normalizePairingCode, PAIRING_TTL_MS, redeemPairingCode } from "../src/store/pairing.ts";
import { deviceCredentials, devices, members, pairingCodes } from "../src/store/schema/identity.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const db = store.db;
  const clock = new ManualClock("test", 100);
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  const memberId = createMember(db, clock, { householdId, homeHostId: hostId, displayName: "甲" });
  return { db, clock, hostId, householdId, memberId, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("配对码为八位 Crockford，规范化并仅存哈希，成功一次后不能重用", () => {
  const { db, clock, memberId, householdId, hostId, store } = setup();
  const issued = issuePairingCode(db, clock, memberId);
  expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(issued.expiresAt).toBe(100 + PAIRING_TTL_MS);
  const normalized = normalizePairingCode(issued.code)!;
  expect(normalizePairingCode(issued.code.toLowerCase())).toBe(normalized);
  const row = db.select().from(pairingCodes).get()!;
  expect(row.codeHash).toBe(createHash("sha256").update(normalized).digest("hex"));
  expect(Buffer.from(store.raw.serialize()).includes(Buffer.from(normalized))).toBe(false);
  const result = redeemPairingCode(db, clock, { code: normalized.toLowerCase(), deviceName: "手机" })!;
  expect(resolveDeviceToken(db, clock, result.token)).toEqual({ memberId, deviceId: result.deviceId, hostId, householdId });
  expect(db.select().from(pairingCodes).get()!.usedAt).toBe(100);
  expect(redeemPairingCode(db, clock, { code: issued.code, deviceName: "又一次" })).toBeUndefined();
  expect(db.select().from(devices).all().length).toBe(1);
});

test("五次合法失败累计烧毁所有活跃码，新码不让旧码失效，格式错误不计数", () => {
  const { db, clock, memberId } = setup();
  const first = issuePairingCode(db, clock, memberId);
  let bad = "00000000";
  while (bad === normalizePairingCode(first.code)) {
    bad = "11111111";
  }
  for (let i = 0; i < 2; i += 1) {
    expect(redeemPairingCode(db, clock, { code: bad, deviceName: "错码" })).toBeUndefined();
  }
  const second = issuePairingCode(db, clock, memberId);
  for (const code of ["IIIIIIII", "OOOOOOOO", "UUUUUUUU", "garbage", "1234567", "123456789", " 01234567"]) {
    expect(normalizePairingCode(code)).toBeUndefined();
    expect(() => redeemPairingCode(db, clock, { code, deviceName: "坏格式" })).toThrow(TypeError);
  }
  expect(db.select().from(pairingCodes).all().map((row) => row.failures)).toEqual([2, 0]);
  for (let i = 0; i < 3; i += 1) {
    redeemPairingCode(db, clock, { code: bad, deviceName: "错码" });
  }
  expect(db.select().from(pairingCodes).all().map((row) => row.failures)).toEqual([5, 3]);
  expect(redeemPairingCode(db, clock, { code: first.code, deviceName: "已烧毁" })).toBeUndefined();
  expect(redeemPairingCode(db, clock, { code: second.code, deviceName: "仍有效" })).toBeDefined();
});

test("十分钟到期边界、成员墓碑拒绝兑换，无设备和秘密半成品", () => {
  const { db, clock, memberId } = setup();
  const first = issuePairingCode(db, clock, memberId);
  clock.advance(PAIRING_TTL_MS);
  expect(redeemPairingCode(db, clock, { code: first.code, deviceName: "过期" })).toBeUndefined();
  expect(db.select().from(pairingCodes).get()!.failures).toBe(0);
  const second = issuePairingCode(db, clock, memberId);
  db.update(members).set({ deletedAt: clock.wallMs() }).where(eq(members.id, memberId)).run();
  expect(redeemPairingCode(db, clock, { code: second.code, deviceName: "墓碑" })).toBeUndefined();
  expect(db.select().from(devices).all()).toEqual([]);
  expect(db.select().from(deviceCredentials).all()).toEqual([]);
  expect(() => issuePairingCode(db, clock, memberId)).toThrow();
});

test("配对失败与设备创建同在立即事务内，调用方回滚不消耗码", () => {
  const { db, clock, memberId, store } = setup();
  const issued = issuePairingCode(db, clock, memberId);
  expect(() => writeTransaction(store, (tx) => {
    expect(redeemPairingCode(tx, clock, { code: issued.code, deviceName: "回滚" })).toBeDefined();
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(db.select().from(pairingCodes).get()!.usedAt).toBeNull();
  expect(db.select().from(devices).all()).toEqual([]);
  expect(redeemPairingCode(db, clock, { code: issued.code, deviceName: "重试" })).toBeDefined();
});
