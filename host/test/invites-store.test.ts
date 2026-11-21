import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ManualClock } from "../src/clock/index.ts";
import { AccessDeniedError } from "../src/identity/access.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { hashCode, normalizeCode } from "../src/store/codes.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { createDevice, createMember, ensureHousehold, listMembers, MemberLimitError, removeMember, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { acceptMemberInvite, bootstrapMember, INVITE_TTL_MS, issueMemberInvite, MemberBootstrapError, revokeMemberInvite } from "../src/store/invites.ts";
import { issuePairingCode, redeemPairingCode } from "../src/store/pairing.ts";
import { deviceCredentials, devices, memberInvites, members } from "../src/store/schema/identity.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const db = store.db;
  const clock = new ManualClock("test", 100);
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  return { store, db, clock, hostId, householdId };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("首成员仅能在零活跃成员时引导，邀请占用空位，墓碑不占名额", () => {
  const { db, clock, householdId } = setup();
  const pending = issueMemberInvite(db, clock, { householdId, maxMembers: 1 });
  expect(() => bootstrapMember(db, clock, { householdId, displayName: "甲", maxMembers: 1 })).toThrow(MemberLimitError);
  revokeMemberInvite(db, clock, { householdId, inviteId: pending.inviteId });
  const first = bootstrapMember(db, clock, { householdId, displayName: "甲" });
  expect(() => bootstrapMember(db, clock, { householdId, displayName: "乙" })).toThrow(MemberBootstrapError);
  removeMember(db, clock, householdId, first.id);
  expect(bootstrapMember(db, clock, { householdId, displayName: "新成员" }).id).not.toBe(first.id);
});

test("活跃成员加有效未用邀请限制新邀请，接受邀请复查配置上限且不消耗失败的码", () => {
  const { db, clock, householdId } = setup();
  const first = bootstrapMember(db, clock, { householdId, displayName: "甲" });
  const pending = issueMemberInvite(db, clock, { householdId, invitedByMemberId: first.id });
  expect(() => issueMemberInvite(db, clock, { householdId })).toThrow(MemberLimitError);
  expect(() => acceptMemberInvite(db, clock, {
    code: pending.code, displayName: "乙", deviceName: "手机", maxMembers: 1,
  })).toThrow(MemberLimitError);
  expect(db.select().from(memberInvites).get()!.usedAt).toBeNull();
  expect(db.select().from(memberInvites).get()!.failures).toBe(0);
  expect(acceptMemberInvite(db, clock, { code: pending.code, displayName: "乙", deviceName: "手机" })).toBeDefined();
  expect(() => issueMemberInvite(db, clock, { householdId })).toThrow(MemberLimitError);
  expect(issueMemberInvite(db, clock, { householdId, maxMembers: 3 })).toBeDefined();
});

test("邀请二十四小时边界过期、撤销和烧毁均释放预留名额", () => {
  const { db, clock, householdId } = setup();
  bootstrapMember(db, clock, { householdId, displayName: "甲" });
  const expired = issueMemberInvite(db, clock, { householdId });
  expect(expired.expiresAt).toBe(clock.wallMs() + INVITE_TTL_MS);
  clock.advance(INVITE_TTL_MS);
  expect(acceptMemberInvite(db, clock, { code: expired.code, displayName: "乙", deviceName: "手机" })).toBeUndefined();
  expect(db.select().from(memberInvites).get()!.failures).toBe(0);
  const revoked = issueMemberInvite(db, clock, { householdId });
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: revoked.inviteId })).toBe(true);
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: revoked.inviteId })).toBe(false);
  expect(acceptMemberInvite(db, clock, { code: revoked.code, displayName: "乙", deviceName: "手机" })).toBeUndefined();
  const live = issueMemberInvite(db, clock, { householdId });
  let wrong = "00000000";
  if (normalizeCode(live.code) === wrong) {
    wrong = "11111111";
  }
  for (let i = 0; i < 5; i += 1) {
    expect(acceptMemberInvite(db, clock, { code: wrong, displayName: "乙", deviceName: "手机" })).toBeUndefined();
  }
  expect(acceptMemberInvite(db, clock, { code: live.code, displayName: "乙", deviceName: "手机" })).toBeUndefined();
  expect(issueMemberInvite(db, clock, { householdId })).toBeDefined();
});

test("规范化与配对共用规则，哈希落库，合法失败对所有活跃邀请计数，格式错误不计数", () => {
  const { db, clock, householdId, store } = setup();
  const first = issueMemberInvite(db, clock, { householdId, displayName: "建议名字" });
  const second = issueMemberInvite(db, clock, { householdId });
  expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(db.select().from(memberInvites).get()!).toMatchObject({
    codeHash: hashCode(normalizeCode(first.code)!), invitedByMemberId: null, displayName: "建议名字",
  });
  expect(Buffer.from(store.raw.serialize()).includes(Buffer.from(normalizeCode(first.code)!))).toBe(false);
  expect(() => acceptMemberInvite(db, clock, { code: "IIIIIIII", displayName: "甲", deviceName: "手机" })).toThrow(TypeError);
  expect(db.select().from(memberInvites).all().map((row) => row.failures)).toEqual([0, 0]);
  let wrong = "00000000";
  while ([first, second].some((invite) => normalizeCode(invite.code) === wrong)) {
    wrong = String(Number(wrong) + 1).padStart(8, "0");
  }
  acceptMemberInvite(db, clock, { code: wrong, displayName: "甲", deviceName: "手机" });
  expect(db.select().from(memberInvites).all().map((row) => row.failures)).toEqual([1, 1]);
  const accepted = acceptMemberInvite(db, clock, { code: first.code.toLowerCase().replace(/-/g, ""), displayName: "自选名字", deviceName: "手机" })!;
  expect(accepted.member.displayName).toBe("自选名字");
  expect(resolveDeviceToken(db, clock, accepted.token)?.memberId).toBe(accepted.member.id);
  expect(acceptMemberInvite(db, clock, { code: first.code, displayName: "重用", deviceName: "手机" })).toBeUndefined();
});

test("成员只可撤销自己的邀请，管理员可撤销任意邀请，跨家庭拒绝", () => {
  const { db, clock, householdId, hostId } = setup();
  const first = bootstrapMember(db, clock, { householdId, displayName: "甲" });
  const second = createMember(db, clock, { householdId, displayName: "乙", homeHostId: hostId });
  const invite = issueMemberInvite(db, clock, { householdId, invitedByMemberId: first.id, maxMembers: 3 });
  expect(() => revokeMemberInvite(db, clock, { householdId, inviteId: invite.inviteId, inviterMemberId: second })).toThrow(AccessDeniedError);
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: invite.inviteId, inviterMemberId: first.id })).toBe(true);
  const admin = issueMemberInvite(db, clock, { householdId, maxMembers: 3 });
  expect(() => revokeMemberInvite(db, clock, { householdId, inviteId: admin.inviteId, inviterMemberId: first.id })).toThrow(AccessDeniedError);
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: admin.inviteId })).toBe(true);
  expect(() => issueMemberInvite(db, clock, { householdId: uuidv7(clock) })).toThrow(AccessDeniedError);
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: uuidv7(clock) })).toBe(false);
});

test("接受与移除均可随外层事务回滚，不留成员、凭证半成品或提前消耗邀请", () => {
  const { db, clock, householdId, store } = setup();
  bootstrapMember(db, clock, { householdId, displayName: "甲" });
  const invite = issueMemberInvite(db, clock, { householdId });
  expect(() => writeTransaction(store, (tx) => {
    acceptMemberInvite(tx, clock, { code: invite.code, displayName: "乙", deviceName: "手机" });
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(listMembers(db, householdId)).toHaveLength(1);
  expect(db.select().from(memberInvites).get()!.usedAt).toBeNull();
  expect(db.select().from(devices).all()).toHaveLength(0);
  expect(db.select().from(deviceCredentials).all()).toHaveLength(0);
  const accepted = acceptMemberInvite(db, clock, { code: invite.code, displayName: "乙", deviceName: "手机" })!;
  expect(() => writeTransaction(store, (tx) => {
    removeMember(tx, clock, householdId, accepted.member.id);
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(resolveDeviceToken(db, clock, accepted.token)).toBeDefined();
});

test("移除成员原子墓碑与撤销所有设备，配对码失效，其它成员不受影响", () => {
  const { db, clock, householdId, hostId } = setup();
  const first = bootstrapMember(db, clock, { householdId, displayName: "甲" });
  const other = createDevice(db, clock, { memberId: first.id, hostId, name: "甲手机" });
  const invite = issueMemberInvite(db, clock, { householdId });
  const second = acceptMemberInvite(db, clock, { code: invite.code, displayName: "乙", deviceName: "乙手机" })!;
  const extra = createDevice(db, clock, { memberId: second.member.id, hostId, name: "乙平板" });
  const code = issuePairingCode(db, clock, second.member.id);
  clock.advance(50);
  expect(removeMember(db, clock, householdId, second.member.id)).toBe(true);
  expect(removeMember(db, clock, householdId, second.member.id)).toBe(false);
  expect(db.select().from(members).where(eq(members.id, second.member.id)).get()).toMatchObject({ deletedAt: 150, updatedAt: 150, rev: 2 });
  expect(db.select().from(devices).where(eq(devices.memberId, second.member.id)).all().every((row) => row.revokedAt === 150)).toBe(true);
  expect(resolveDeviceToken(db, clock, second.token)).toBeUndefined();
  expect(resolveDeviceToken(db, clock, extra.token)).toBeUndefined();
  expect(resolveDeviceToken(db, clock, other.token)).toBeDefined();
  expect(redeemPairingCode(db, clock, { code: code.code, deviceName: "已移除" })).toBeUndefined();
  expect(listMembers(db, householdId).map((row) => row.id)).toEqual([first.id]);
});
