import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { encodeHlc } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";
import type { Actor } from "../identity/index.ts";
import { DEFAULT_MAX_MEMBERS } from "../runtime/config.ts";
import { getHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { deviceCredentials, devices, households, hosts, members } from "./schema/identity.ts";

export class MemberLimitError extends Error {
  constructor(public readonly maxMembers: number) {
    super(`家庭成员数已达上限：${maxMembers}`);
    this.name = "MemberLimitError";
  }
}

function wallMs(clock: Clock): number {
  const now = clock.wallMs();
  validateWallMs(now);
  return now;
}

function revision(clock: Clock) {
  return { hlc: encodeHlc(clock.hlc()), updatedAt: wallMs(clock) };
}

function businessRow(clock: Clock, originHostId: string) {
  const id = uuidv7(clock);
  const update = revision(clock);
  return { id, originHostId, ...update, rev: 1, createdAt: update.updatedAt, deletedAt: null };
}

function localHostId(db: Pick<StoreDb, "select">): string {
  const id = getHostMeta(db, "host_id");
  if (!id) {
    throw new Error("宿主身份尚未初始化");
  }
  return id;
}

function requireName(name: string): void {
  if (!name.trim()) {
    throw new TypeError("名称不能为空");
  }
}

export function getHousehold(db: Pick<StoreDb, "select">, householdId: string) {
  return db.select().from(households).where(and(
    eq(households.id, householdId), isNull(households.deletedAt),
  )).get();
}

export function getMember(db: Pick<StoreDb, "select">, memberId: string) {
  return db.select().from(members).where(and(eq(members.id, memberId), isNull(members.deletedAt))).get();
}

export function ensureHousehold(
  db: StoreDb,
  clock: Clock,
  hostId: string,
  input: { householdName: string; hostName: string },
): string {
  requireName(input.householdName);
  requireName(input.hostName);
  return db.transaction((tx) => {
    const existing = tx.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (existing) {
      if (existing.deletedAt !== null || !getHousehold(tx, existing.householdId)) {
        throw new Error("宿主或家庭已删除，不能自动重新引导");
      }
      return existing.householdId;
    }
    const household = { ...businessRow(clock, hostId), name: input.householdName };
    tx.insert(households).values(household).run();
    const hostRevision = revision(clock);
    tx.insert(hosts).values({
      id: hostId,
      originHostId: hostId,
      ...hostRevision,
      rev: 1,
      createdAt: hostRevision.updatedAt,
      deletedAt: null,
      householdId: household.id,
      displayName: input.hostName,
    }).run();
    return household.id;
  }, { behavior: "immediate" });
}

export function listMembers(db: Pick<StoreDb, "select">, householdId: string) {
  return db.select().from(members).where(and(
    eq(members.householdId, householdId), isNull(members.deletedAt),
  )).orderBy(asc(members.id)).all();
}

export function createMember(
  db: StoreDb,
  clock: Clock,
  input: { householdId: string; displayName: string; homeHostId: string; maxMembers?: number },
): string {
  requireName(input.displayName);
  const maxMembers = input.maxMembers ?? DEFAULT_MAX_MEMBERS;
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
    throw new RangeError("成员上限必须是正整数");
  }
  return db.transaction((tx) => {
    const home = tx.select().from(hosts).where(and(
      eq(hosts.id, input.homeHostId), isNull(hosts.deletedAt),
    )).get();
    if (!getHousehold(tx, input.householdId) || home?.householdId !== input.householdId) {
      throw new Error("家庭不存在或 home host 不属于该家庭");
    }
    const active = tx.select({ count: count() }).from(members).where(and(
      eq(members.householdId, input.householdId), isNull(members.deletedAt),
    )).get()!.count;
    if (active >= maxMembers) {
      throw new MemberLimitError(maxMembers);
    }
    const row = {
      ...businessRow(clock, localHostId(tx)),
      householdId: input.householdId,
      displayName: input.displayName,
      homeHostId: input.homeHostId,
    };
    tx.insert(members).values(row).run();
    return row.id;
  }, { behavior: "immediate" });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDevice(
  db: StoreDb,
  clock: Clock,
  input: { memberId: string; hostId: string; name: string },
): { deviceId: string; token: string } {
  requireName(input.name);
  return db.transaction((tx) => {
    const member = getMember(tx, input.memberId);
    const host = tx.select().from(hosts).where(and(eq(hosts.id, input.hostId), isNull(hosts.deletedAt))).get();
    if (!member || !host || member.householdId !== host.householdId || !getHousehold(tx, member.householdId)) {
      throw new Error("成员与设备宿主必须属于同一有效家庭");
    }
    const row = {
      ...businessRow(clock, localHostId(tx)),
      memberId: input.memberId,
      hostId: input.hostId,
      name: input.name,
      lastSeenAt: null,
      revokedAt: null,
    };
    const token = `mm_dvc_${randomBytes(32).toString("base64url")}`;
    tx.insert(devices).values(row).run();
    tx.insert(deviceCredentials).values({ deviceId: row.id, tokenHash: tokenHash(token) }).run();
    return { deviceId: row.id, token };
  }, { behavior: "immediate" });
}

export function revokeDevice(db: StoreDb, clock: Clock, deviceId: string): boolean {
  return db.transaction((tx) => {
    const update = revision(clock);
    return tx.update(devices).set({
      ...update, revokedAt: update.updatedAt, rev: sql`${devices.rev} + 1`,
    }).where(and(eq(devices.id, deviceId), isNull(devices.revokedAt), isNull(devices.deletedAt)))
      .returning({ id: devices.id }).get() !== undefined;
  }, { behavior: "immediate" });
}

export function resolveDeviceToken(db: StoreDb, clock: Clock, token: string): Actor | undefined {
  if (!/^mm_dvc_[A-Za-z0-9_-]{43}$/.test(token)) {
    return undefined;
  }
  return db.transaction((tx) => {
    const hostId = getHostMeta(tx, "host_id");
    if (!hostId) {
      return undefined;
    }
    const actor = tx.select({
      memberId: members.id,
      deviceId: devices.id,
      hostId: devices.hostId,
      householdId: members.householdId,
    }).from(deviceCredentials)
      .innerJoin(devices, eq(deviceCredentials.deviceId, devices.id))
      .innerJoin(members, eq(devices.memberId, members.id))
      .innerJoin(hosts, and(eq(devices.hostId, hosts.id), eq(hosts.householdId, members.householdId)))
      .innerJoin(households, eq(members.householdId, households.id))
      .where(and(
        eq(deviceCredentials.tokenHash, tokenHash(token)), eq(devices.hostId, hostId),
        isNull(devices.revokedAt), isNull(devices.deletedAt), isNull(members.deletedAt),
        isNull(hosts.deletedAt), isNull(households.deletedAt),
      )).get();
    if (!actor) {
      return undefined;
    }
    const update = revision(clock);
    tx.update(devices).set({ ...update, lastSeenAt: update.updatedAt, rev: sql`${devices.rev} + 1` })
      .where(eq(devices.id, actor.deviceId)).run();
    return actor;
  }, { behavior: "immediate" });
}
