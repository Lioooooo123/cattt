import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ManualClock, parseHlc } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { DEFAULT_MAX_MEMBERS } from "../src/runtime/config.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import {
  createDevice, createMember, ensureHousehold, getHousehold, getMember, listMembers,
  MemberLimitError, resolveDeviceToken, revokeDevice,
} from "../src/store/identity.ts";
import { deviceCredentials, devices, households, hosts, members } from "../src/store/schema/identity.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const db = store.db;
  const clock = new ManualClock("test", 100);
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  const member = (displayName: string, maxMembers = DEFAULT_MAX_MEMBERS) => createMember(db, clock, {
    householdId, homeHostId: hostId, displayName, maxMembers,
  });
  return { store, db, clock, hostId, householdId, member };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("首次引导创建一个家庭和运行时宿主，重复引导不覆盖名称或修订", () => {
  const { db, clock, hostId, householdId } = setup();
  const first = getHousehold(db, householdId)!;
  expect(ensureHousehold(db, clock, hostId, { householdName: "其它名", hostName: "其它宿主" })).toBe(householdId);
  expect(db.select().from(households).all()).toEqual([first]);
  expect(first).toMatchObject({ originHostId: hostId, rev: 1, createdAt: 100, updatedAt: 100, deletedAt: null });
  expect(first.id).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]+$/);
  expect(parseHlc(first.hlc)).toMatchObject({ nodeId: "test", physicalMs: 100 });
  expect(db.select().from(hosts).all()).toMatchObject([{ id: hostId, householdId, displayName: "Mac", rev: 1 }]);
  expect(listMembers(db, householdId)).toEqual([]);
});

test("两成员各自凭证解析为不同 Actor，仅设备本机持有哈希，last_seen 及修订来自 Clock", () => {
  const { db, clock, hostId, householdId, member, store } = setup();
  const ids = [member("甲"), member("乙")];
  const issued = ids.map((memberId) => createDevice(db, clock, { memberId, hostId, name: "iPhone" }));
  clock.advance(50);
  issued.forEach(({ deviceId, token }, index) => {
    expect(token).toMatch(/^mm_dvc_[A-Za-z0-9_-]{43}$/);
    const actor = resolveDeviceToken(db, clock, token);
    expect(actor).toEqual({ memberId: ids[index]!, deviceId, hostId, householdId });
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()!;
    expect(row).toMatchObject({ lastSeenAt: 150, updatedAt: 150, rev: 2, originHostId: hostId });
    expect(parseHlc(row.hlc).physicalMs).toBe(150);
    const credential = db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, deviceId)).get()!;
    expect(credential).toEqual({ deviceId, tokenHash: createHash("sha256").update(token).digest("hex") });
    expect(Object.keys(row)).not.toContain("tokenHash");
    expect(Buffer.from(store.raw.serialize()).includes(Buffer.from(token))).toBe(false);
  });
  expect(issued[0]!.token).not.toBe(issued[1]!.token);
  expect(listMembers(db, householdId).map((row) => row.displayName)).toEqual(["甲", "乙"]);
});

test("成员数配置默认上限阻止第三人，扩容后允许，墓碑不占活跃名额", () => {
  const { db, clock, householdId, member } = setup();
  const first = member("甲");
  member("乙");
  expect(() => member("丙")).toThrow(MemberLimitError);
  expect(listMembers(db, householdId).length).toBe(DEFAULT_MAX_MEMBERS);
  const third = member("丙", 3);
  expect(getMember(db, third)!.displayName).toBe("丙");
  db.update(members).set({ deletedAt: clock.wallMs() }).where(eq(members.id, first)).run();
  expect(getMember(db, first)).toBeUndefined();
  expect(listMembers(db, householdId).map((row) => row.id)).not.toContain(first);
  expect(member("丁", 3)).toBeString();
});

test("未知、撤销、成员或设备墓碑不再解析凭证，撤销幂等且递增修订", () => {
  const { db, clock, hostId, member } = setup();
  const memberId = member("甲");
  const first = createDevice(db, clock, { memberId, hostId, name: "一" });
  expect(resolveDeviceToken(db, clock, "garbage")).toBeUndefined();
  expect(resolveDeviceToken(db, clock, `mm_dvc_${"a".repeat(43)}`)).toBeUndefined();
  clock.advance(10);
  expect(revokeDevice(db, clock, first.deviceId)).toBe(true);
  expect(revokeDevice(db, clock, first.deviceId)).toBe(false);
  expect(revokeDevice(db, clock, "missing")).toBe(false);
  expect(resolveDeviceToken(db, clock, first.token)).toBeUndefined();
  expect(db.select().from(devices).where(eq(devices.id, first.deviceId)).get())
    .toMatchObject({ revokedAt: 110, updatedAt: 110, rev: 2, lastSeenAt: null });
  const second = createDevice(db, clock, { memberId, hostId, name: "二" });
  db.update(devices).set({ deletedAt: 110 }).where(eq(devices.id, second.deviceId)).run();
  expect(resolveDeviceToken(db, clock, second.token)).toBeUndefined();
  const third = createDevice(db, clock, { memberId, hostId, name: "三" });
  db.update(members).set({ deletedAt: 110 }).where(eq(members.id, memberId)).run();
  expect(resolveDeviceToken(db, clock, third.token)).toBeUndefined();
});

test("远端宿主设备的凭证即使在本地也拒绝，家庭归属不一致不能建成员或设备", () => {
  const { db, clock, hostId, householdId, member } = setup();
  const memberId = member("甲");
  const otherHostId = uuidv7(clock);
  const local = db.select().from(hosts).where(eq(hosts.id, hostId)).get()!;
  db.insert(hosts).values({ ...local, id: otherHostId, displayName: "另一台 Mac" }).run();
  const remote = createDevice(db, clock, { memberId, hostId: otherHostId, name: "对端 iPhone" });
  expect(resolveDeviceToken(db, clock, remote.token)).toBeUndefined();
  expect(db.select().from(devices).where(eq(devices.id, remote.deviceId)).get()!.lastSeenAt).toBeNull();
  const foreignHostId = uuidv7(clock);
  const household = db.select().from(households).where(eq(households.id, householdId)).get()!;
  const foreignHouseholdId = uuidv7(clock);
  db.insert(households).values({ ...household, id: foreignHouseholdId, originHostId: foreignHostId, name: "另一个家" }).run();
  db.insert(hosts).values({
    ...local, id: foreignHostId, originHostId: foreignHostId, householdId: foreignHouseholdId, displayName: "陌生 Mac",
  }).run();
  expect(() => createMember(db, clock, {
    householdId, homeHostId: foreignHostId, displayName: "错配",
  })).toThrow();
  expect(() => createDevice(db, clock, { memberId, hostId: foreignHostId, name: "错配设备" })).toThrow();
});

test("创建身份也参与调用方事务回滚，无效输入与 FK 不产生半成品", () => {
  const { db, clock, hostId, householdId, store, member } = setup();
  expect(() => writeTransaction(store, (tx) => {
    const memberId = createMember(tx, clock, { householdId, homeHostId: hostId, displayName: "甲" });
    createDevice(tx, clock, { memberId, hostId, name: "iPhone" });
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(listMembers(db, householdId)).toEqual([]);
  expect(db.select().from(devices).all()).toEqual([]);
  expect(db.select().from(deviceCredentials).all()).toEqual([]);
  for (const maxMembers of [0, -1, 1.5]) {
    expect(() => member("甲", maxMembers)).toThrow(RangeError);
  }
  expect(() => member(" ")).toThrow(TypeError);
  expect(() => createDevice(db, clock, { memberId: "missing", hostId, name: "iPhone" })).toThrow();
  expect(() => db.insert(deviceCredentials).values({ deviceId: "missing", tokenHash: "hash" }).run()).toThrow();
});
