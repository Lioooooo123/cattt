import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { SQLiteBunSession } from "drizzle-orm/bun-sqlite/session";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import { AccessDeniedError } from "../src/identity/access.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { hashCode, normalizeCode } from "../src/store/codes.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { createDevice, createMember, ensureHousehold, getHousehold, listMembers, MemberLimitError, removeMember, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { acceptMemberInvite, bootstrapMember, INVITE_TTL_MS, issueMemberInvite, MemberBootstrapError, prepareJoinedMemberInvite, revokeMemberInvite } from "../src/store/invites.ts";
import { confirmJoinedMemberSeat, creatorSeatInspections, inspectJoinedMemberSeats, MemberSeatAuthorityPendingError, MemberSeatUnavailableError, recordCreatorSeatInspection, reserveJoinedMemberSeat } from "../src/store/member-seats.ts";
import { migrations } from "../src/store/migrations.generated.ts";
import { issuePairingCode, redeemPairingCode } from "../src/store/pairing.ts";
import { approvePeer, confirmPeer, joinPeerHousehold } from "../src/store/peers.ts";
import { createPeerSyncService } from "../src/replication/peer-service.ts";
import { applyReplicaSnapshot } from "../src/store/replication-snapshot.ts";
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

function joinReplica(a: ReturnType<typeof setup>) {
  const b = setup();
  joinPeerHousehold(b.db, b.clock, b.hostId, b.householdId, getHousehold(a.db, a.householdId)!, {
    hostId: a.hostId, householdId: a.householdId, joinFromHouseholdId: null,
    addressHost: "127.0.0.1", addressPort: 1, caCertificate: "fixture", fingerprint: "fixture", protocolVersion: 8,
  });
  const sync = createPeerSyncService(a.db, a.hostId);
  const { source, data } = sync.openSnapshot();
  const { records } = sync.readSnapshotPage({ snapshotId: data.snapshotId, offset: 0, limit: data.recordCount }).data;
  expect(applyReplicaSnapshot(b.db, source, null, data, records).status).toBe("applied");
  const peer = approvePeer(a.db, a.clock, {
    hostId: b.hostId, householdId: a.householdId, joinFromHouseholdId: null,
    addressHost: "127.0.0.1", addressPort: 1, caCertificate: "fixture", fingerprint: b.hostId, protocolVersion: 9,
  });
  confirmPeer(a.db, a.clock, peer, 9, "fixture");
  return b;
}

test("加入宿主的完整家庭视图不能代替创建宿主的准入授权", () => {
  const a = setup();
  bootstrapMember(a.db, a.clock, { householdId: a.householdId, displayName: "甲" });
  const b = joinReplica(a);
  expect(listMembers(b.db, a.householdId)).toHaveLength(1);
  expect(() => issueMemberInvite(b.db, b.clock, { householdId: a.householdId })).toThrow("等待家庭创建宿主");
  expect(b.db.select().from(memberInvites).all()).toHaveLength(0);
  expect(b.db.select().from(deviceCredentials).all()).toHaveLength(0);
});

test("同一家庭名额可换发给另一台配对 Mac，确认后的名额跟随成员墓碑回收", () => {
  const a = setup();
  const householdId = a.householdId;
  bootstrapMember(a.db, a.clock, { householdId, displayName: "甲" });
  const b = joinReplica(a);
  const c = joinReplica(a);
  const waiting = prepareJoinedMemberInvite(b.db, b.clock, { householdId });
  const bSeat = { householdId, peerHostId: b.hostId, memberId: waiting.seatMemberId! };
  reserveJoinedMemberSeat(a.db, a.clock, bSeat, 2);
  expect(() => confirmJoinedMemberSeat(a.db, a.clock, { ...bSeat, peerHostId: c.hostId }, 2)).toThrow(MemberSeatUnavailableError);
  expect(() => acceptMemberInvite(b.db, b.clock, {
    code: waiting.code, displayName: "乙", deviceName: "手机",
  })).toThrow(MemberSeatAuthorityPendingError);
  expect(b.db.select().from(deviceCredentials).all()).toHaveLength(0);
  a.clock.advance(INVITE_TTL_MS);
  expect(() => confirmJoinedMemberSeat(a.db, a.clock, bSeat, 2)).toThrow(MemberSeatUnavailableError);

  const next = prepareJoinedMemberInvite(c.db, c.clock, { householdId });
  const cSeat = { householdId, peerHostId: c.hostId, memberId: next.seatMemberId! };
  reserveJoinedMemberSeat(a.db, a.clock, cSeat, 2);
  expect(() => confirmJoinedMemberSeat(a.db, a.clock, bSeat, 2)).toThrow(MemberSeatUnavailableError);
  confirmJoinedMemberSeat(a.db, a.clock, cSeat, 2);
  const accepted = acceptMemberInvite(c.db, c.clock, {
    code: next.code, displayName: "乙", deviceName: "手机",
    confirmedSeat: { memberId: cSeat.memberId, inviteId: next.inviteId },
  })!;
  expect(accepted.member.homeHostId).toBe(c.hostId);
  a.clock.advance(INVITE_TTL_MS);
  expect(() => issueMemberInvite(a.db, a.clock, { householdId })).toThrow(MemberLimitError);
  removeMember(c.db, c.clock, householdId, accepted.member.id);
  const inspected = inspectJoinedMemberSeats(c.db, c.clock, householdId, {
    creatorHostId: a.hostId, legacy: false, memberIds: [cSeat.memberId],
  });
  expect(inspected.retired).toEqual([cSeat.memberId]);
  recordCreatorSeatInspection(a.db, a.clock, cSeat, { retired: inspected.retired });
  expect(issueMemberInvite(a.db, a.clock, { householdId })).toBeDefined();
});

test("0025 升级保留创建宿主的旧链接，撤销加入宿主的旧链接并等待它的成员核对", () => {
  const clock = new ManualClock("test", 100);
  const [householdId, a, b, first, partner, localInvite, joinedInvite] = Array.from({ length: 7 }, () => uuidv7(clock));
  const dir = mkdtempSync(join(tmpdir(), "cattt-seat-migration-"));
  const code = "0123-4567";
  const seed = (path: string, host: string) => {
    const raw = new Database(path, { strict: true });
    try {
      const dialect = new SQLiteSyncDialect();
      dialect.migrate(migrations.slice(0, 26), new SQLiteBunSession(raw, dialect, undefined));
      raw.run("INSERT INTO host_meta (key, value) VALUES ('host_id', ?)", [host]);
      const meta = (id: string, origin: string) => [id, origin, "100:0:test", 1, 100, 100, null];
      raw.run("INSERT INTO households VALUES (?, ?, ?, ?, ?, ?, ?, '家')", meta(householdId!, a!));
      raw.run("INSERT INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?, ?, '甲 Mac')", [...meta(a!, a!), householdId!]);
      raw.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, '甲', ?)", [...meta(first!, a!), householdId!, a!]);
      if (host === a) {
        raw.run(`INSERT INTO peers (host_id, household_id, address_host, address_port, ca_certificate, fingerprint,
          protocol_version, approved_at, confirmed_at) VALUES (?, ?, '127.0.0.1', 1, 'fixture', 'fixture', 8, 100, 100)`,
          [b!, householdId!]);
      } else {
        raw.run("INSERT INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?, ?, '乙 Mac')", [...meta(b!, b!), householdId!]);
        raw.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, '乙', ?)", [...meta(partner!, b!), householdId!, b!]);
      }
      raw.run("INSERT INTO member_invites VALUES (?, ?, NULL, ?, NULL, ?, NULL, NULL, 0, 100)",
        [host === a ? localInvite! : joinedInvite!, householdId!, hashCode(normalizeCode(code)!), INVITE_TTL_MS + 100]);
    } finally { raw.close(); }
  };
  const aPath = join(dir, "a.db");
  const bPath = join(dir, "b.db");
  try {
    seed(aPath, a!);
    seed(bPath, b!);
    const creator = openStore(aPath);
    const joined = openStore(bPath);
    try {
      expect(creator.db.select().from(memberInvites).get()?.revokedAt).toBeNull();
      expect(joined.db.select().from(memberInvites).get()?.revokedAt).not.toBeNull();
      expect(acceptMemberInvite(joined.db, clock, { code, displayName: "候选", deviceName: "手机" })).toBeUndefined();
      expect(listMembers(creator.db, householdId!)).toHaveLength(1);
      expect(creatorSeatInspections(creator.db, clock, householdId!).get(b!)?.legacy).toBe(true);
      const accept = () => acceptMemberInvite(creator.db, clock, { code, displayName: "候选", deviceName: "手机" });
      expect(accept).toThrow(MemberSeatAuthorityPendingError);
      const inspection = inspectJoinedMemberSeats(joined.db, clock, householdId!, {
        creatorHostId: a!, legacy: true, memberIds: [],
      });
      expect(inspection.legacyMemberIds).toEqual([partner!]);
      recordCreatorSeatInspection(creator.db, clock, { householdId: householdId!, peerHostId: b! }, inspection);
      expect(accept).toThrow(MemberLimitError);
      expect(creator.db.select().from(deviceCredentials).all()).toHaveLength(0);
    } finally {
      joined.close();
      creator.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("重试已用、过期、撤销或烧毁的旧邀请不影响有效的新邀请", () => {
  const { db, clock, householdId } = setup();
  const accept = (code: string) => acceptMemberInvite(db, clock, {
    code, displayName: "成员", deviceName: "手机", maxMembers: 3,
  });
  const issue = () => issueMemberInvite(db, clock, { householdId, maxMembers: 3 });
  const used = issue();
  expect(accept(used.code)).toBeDefined();
  const expired = issue();
  clock.advance(INVITE_TTL_MS);
  const cancelled = issue();
  expect(revokeMemberInvite(db, clock, { householdId, inviteId: cancelled.inviteId })).toBe(true);
  const exhausted = issue();
  let unknown = "00000000";
  while ([used, expired, cancelled, exhausted].some(({ code }) => normalizeCode(code) === unknown)) {
    unknown = String(Number(unknown) + 1).padStart(8, "0");
  }
  for (let i = 0; i < 5; i++) expect(accept(unknown)).toBeUndefined();

  const replacement = issue();
  for (const { code } of [used, expired, cancelled, exhausted, cancelled]) {
    expect(accept(code)).toBeUndefined();
  }
  expect(db.select().from(memberInvites).where(eq(memberInvites.id, replacement.inviteId)).get()?.failures).toBe(0);
  expect(accept(replacement.code)).toBeDefined();
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
