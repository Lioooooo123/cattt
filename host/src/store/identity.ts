import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { AccessDeniedError } from "../identity/access.ts";
import { DEFAULT_MAX_MEMBERS } from "../runtime/config.ts";
import { getHostMeta, requireLocalHostId as localHostId } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { devicePushRegistrations } from "./schema/push.ts";
import { deviceCredentials, devices, households, hosts, members } from "./schema/identity.ts";
import { businessRow, revision } from "./business.ts";
import { ensureGroup, reconcileConversations } from "./conversation-lifecycle.ts";
import { appendNativeChange, initializeNativeReplication } from "./replication.ts";
import { replicaAdapters } from "./replica-records.ts";

export class MemberLimitError extends Error {
  constructor(public readonly maxMembers: number) {
    super(`家庭成员数已达上限：${maxMembers}`);
    this.name = "MemberLimitError";
  }
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

export function getHouseholdMember(db: Pick<StoreDb, "select">, householdId: string, memberId: string) {
  const member = getMember(db, memberId);
  return member?.householdId === householdId ? member : undefined;
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
      initializeNativeReplication(tx, hostId, existing.householdId);
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
    initializeNativeReplication(tx, hostId, household.id);
    ensureGroup(tx, clock, hostId, household.id);
    return household.id;
  }, { behavior: "immediate" });
}

export function listMembers(db: Pick<StoreDb, "select">, householdId: string) {
  return db.select().from(members).where(and(
    eq(members.householdId, householdId), isNull(members.deletedAt),
  )).orderBy(asc(members.id)).all();
}

export function createMember(
  db: Pick<StoreDb, "transaction">,
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
    const hostId = localHostId(tx);
    const row = {
      ...businessRow(clock, hostId),
      householdId: input.householdId,
      displayName: input.displayName,
      homeHostId: input.homeHostId,
    };
    tx.insert(members).values(row).run();
    appendNativeChange(tx, hostId, input.householdId, replicaAdapters.member, row);
    reconcileConversations(tx, clock, hostId, input.householdId);
    return row.id;
  }, { behavior: "immediate" });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDevice(
  db: Pick<StoreDb, "transaction">,
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

export function revokeDevice(db: Pick<StoreDb, "transaction">, clock: Clock, deviceId: string): boolean {
  return db.transaction((tx) => {
    const update = revision(clock);
    const revoked = tx.update(devices).set({
      ...update, revokedAt: update.updatedAt, rev: sql`${devices.rev} + 1`,
    }).where(and(eq(devices.id, deviceId), isNull(devices.revokedAt), isNull(devices.deletedAt)))
      .returning({ id: devices.id }).get();
    if (revoked) tx.delete(devicePushRegistrations).where(eq(devicePushRegistrations.deviceId, deviceId)).run();
    return revoked !== undefined;
  }, { behavior: "immediate" });
}

export function removeMember(db: StoreDb, clock: Clock, householdId: string, memberId: string): boolean {
  return db.transaction((tx) => {
    const member = getMember(tx, memberId);
    if (!member || member.householdId !== householdId) {
      return false;
    }
    const hostId = localHostId(tx);
    if (member.originHostId !== hostId) {
      throw new AccessDeniedError();
    }
    const update = revision(clock);
    const removed = tx.update(members).set({ ...update, deletedAt: update.updatedAt, rev: sql`${members.rev} + 1` })
      .where(eq(members.id, memberId)).returning().get()!;
    appendNativeChange(tx, hostId, householdId, replicaAdapters.member, removed);
    const revoked = tx.update(devices).set({ ...update, revokedAt: update.updatedAt, rev: sql`${devices.rev} + 1` })
      .where(and(eq(devices.memberId, memberId), isNull(devices.revokedAt), isNull(devices.deletedAt)))
      .returning({ id: devices.id }).all();
    for (const { id } of revoked) {
      tx.delete(devicePushRegistrations).where(eq(devicePushRegistrations.deviceId, id)).run();
    }
    reconcileConversations(tx, clock, hostId, householdId);
    return true;
  }, { behavior: "immediate" });
}

export function isCurrentDeviceActor(db: Pick<StoreDb, "select">, actor: Actor): boolean {
  return db.select({ id: devices.id }).from(devices)
    .innerJoin(members, eq(devices.memberId, members.id))
    .innerJoin(hosts, and(eq(devices.hostId, hosts.id), eq(hosts.householdId, members.householdId)))
    .innerJoin(households, eq(members.householdId, households.id))
    .where(and(
      eq(devices.id, actor.deviceId), eq(devices.hostId, actor.hostId), eq(members.id, actor.memberId),
      eq(members.householdId, actor.householdId), isNull(devices.revokedAt), isNull(devices.deletedAt),
      isNull(members.deletedAt), isNull(hosts.deletedAt), isNull(households.deletedAt),
    )).get() !== undefined;
}

function activeDeviceActors(db: Pick<StoreDb, "select">) {
  return db.select({
    memberId: members.id,
    deviceId: devices.id,
    hostId: devices.hostId,
    householdId: members.householdId,
  }).from(deviceCredentials)
    .innerJoin(devices, and(eq(deviceCredentials.deviceId, devices.id), isNull(devices.revokedAt), isNull(devices.deletedAt)))
    .innerJoin(members, and(eq(devices.memberId, members.id), isNull(members.deletedAt)))
    .innerJoin(hosts, and(eq(devices.hostId, hosts.id), eq(hosts.householdId, members.householdId), isNull(hosts.deletedAt)))
    .innerJoin(households, and(eq(members.householdId, households.id), isNull(households.deletedAt)));
}

export function isActiveDeviceActor(db: Pick<StoreDb, "select">, actor: Actor): boolean {
  return getHostMeta(db, "host_id") === actor.hostId && activeDeviceActors(db).where(and(
    eq(devices.id, actor.deviceId), eq(devices.hostId, actor.hostId),
    eq(members.id, actor.memberId), eq(members.householdId, actor.householdId),
  )).get() !== undefined;
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
    const actor = activeDeviceActors(tx).where(and(
      eq(deviceCredentials.tokenHash, tokenHash(token)), eq(devices.hostId, hostId),
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
