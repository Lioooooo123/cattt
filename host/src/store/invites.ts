import { and, count, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";
import { AccessDeniedError } from "../identity/access.ts";
import { DEFAULT_MAX_MEMBERS } from "../runtime/config.ts";
import { failedCode, generateCode, hashCode, liveCode, normalizeCode } from "./codes.ts";
import { getHostMeta } from "./host-meta.ts";
import { createDevice, createMember, getHousehold, getMember, MemberLimitError } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { hosts, memberInvites, members } from "./schema/identity.ts";

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export class MemberBootstrapError extends Error {
  constructor() {
    super("已有成员，后续成员必须通过邀请加入");
    this.name = "MemberBootstrapError";
  }
}

function wallMs(clock: Clock): number {
  const now = clock.wallMs();
  validateWallMs(now);
  return now;
}

function requireName(name: string): void {
  if (!name.trim() || name.trim().length > 100) {
    throw new TypeError("名称须为 1 至 100 个字符");
  }
}

function limit(value = DEFAULT_MAX_MEMBERS): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("成员上限必须是正整数");
  }
  return value;
}

function localHost(db: Pick<StoreDb, "select">, householdId: string) {
  const host = db.select().from(hosts).where(and(
    eq(hosts.id, getHostMeta(db, "host_id") ?? ""), isNull(hosts.deletedAt),
  )).get();
  if (!host || host.householdId !== householdId || !getHousehold(db, householdId)) {
    throw new AccessDeniedError();
  }
  return host;
}

function activeMembers(db: Pick<StoreDb, "select">, householdId: string): number {
  return db.select({ count: count() }).from(members).where(and(
    eq(members.householdId, householdId), isNull(members.deletedAt),
  )).get()!.count;
}

function assertUnreservedSlot(db: Pick<StoreDb, "select">, householdId: string, now: number, max: number) {
  const pending = db.select({ count: count() }).from(memberInvites).where(and(
    eq(memberInvites.householdId, householdId), liveCode(memberInvites, now),
  )).get()!.count;
  if (activeMembers(db, householdId) + pending >= max) {
    throw new MemberLimitError(max);
  }
}

export function bootstrapMember(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: { householdId: string; displayName: string; maxMembers?: number },
) {
  requireName(input.displayName);
  const max = limit(input.maxMembers);
  return db.transaction((tx) => {
    const host = localHost(tx, input.householdId);
    if (activeMembers(tx, input.householdId) !== 0) {
      throw new MemberBootstrapError();
    }
    assertUnreservedSlot(tx, input.householdId, wallMs(clock), max);
    const memberId = createMember(tx, clock, {
      householdId: input.householdId, displayName: input.displayName.trim(), homeHostId: host.id, maxMembers: max,
    });
    return getMember(tx, memberId)!;
  }, { behavior: "immediate" });
}

export function issueMemberInvite(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: { householdId: string; displayName?: string; invitedByMemberId?: string; maxMembers?: number },
) {
  if (input.displayName !== undefined) {
    requireName(input.displayName);
  }
  const max = limit(input.maxMembers);
  return db.transaction((tx) => {
    localHost(tx, input.householdId);
    if (input.invitedByMemberId !== undefined) {
      const inviter = getMember(tx, input.invitedByMemberId);
      if (inviter?.householdId !== input.householdId) {
        throw new AccessDeniedError();
      }
    }
    const now = wallMs(clock);
    assertUnreservedSlot(tx, input.householdId, now, max);
    const issued = generateCode((hash) => tx.select({ id: memberInvites.id }).from(memberInvites)
      .where(eq(memberInvites.codeHash, hash)).get() !== undefined);
    const expiresAt = now + INVITE_TTL_MS;
    validateWallMs(expiresAt);
    const inviteId = uuidv7(clock);
    tx.insert(memberInvites).values({
      id: inviteId, householdId: input.householdId, displayName: input.displayName?.trim() ?? null,
      codeHash: issued.codeHash, invitedByMemberId: input.invitedByMemberId ?? null,
      expiresAt, usedAt: null, revokedAt: null, failures: 0, createdAt: now,
    }).run();
    return { inviteId, code: issued.code, expiresAt };
  }, { behavior: "immediate" });
}

export function acceptMemberInvite(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: { code: string; displayName: string; deviceName: string; maxMembers?: number },
) {
  const normalized = normalizeCode(input.code);
  if (!normalized) {
    throw new TypeError("邀请码格式无效");
  }
  requireName(input.displayName);
  requireName(input.deviceName);
  const max = limit(input.maxMembers);
  return db.transaction((tx) => {
    const now = wallMs(clock);
    const invite = tx.select().from(memberInvites).where(and(
      liveCode(memberInvites, now), eq(memberInvites.codeHash, hashCode(normalized)),
    )).get();
    if (!invite) {
      tx.update(memberInvites).set(failedCode(memberInvites)).where(liveCode(memberInvites, now)).run();
      return undefined;
    }
    const host = localHost(tx, invite.householdId);
    const memberId = createMember(tx, clock, {
      householdId: invite.householdId, displayName: input.displayName.trim(), homeHostId: host.id, maxMembers: max,
    });
    const device = createDevice(tx, clock, { memberId, hostId: host.id, name: input.deviceName.trim() });
    tx.update(memberInvites).set({ usedAt: now }).where(eq(memberInvites.id, invite.id)).run();
    const household = getHousehold(tx, invite.householdId)!;
    return { ...device, member: getMember(tx, memberId)!, household: { id: household.id, name: household.name } };
  }, { behavior: "immediate" });
}

export function revokeMemberInvite(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: { inviteId: string; householdId: string; inviterMemberId?: string },
): boolean {
  return db.transaction((tx) => {
    localHost(tx, input.householdId);
    const invite = tx.select().from(memberInvites).where(and(
      eq(memberInvites.id, input.inviteId), eq(memberInvites.householdId, input.householdId),
    )).get();
    if (!invite) {
      return false;
    }
    if (input.inviterMemberId !== undefined && invite.invitedByMemberId !== input.inviterMemberId) {
      throw new AccessDeniedError();
    }
    if (invite.usedAt !== null || invite.revokedAt !== null) {
      return false;
    }
    tx.update(memberInvites).set({ revokedAt: wallMs(clock) }).where(eq(memberInvites.id, invite.id)).run();
    return true;
  }, { behavior: "immediate" });
}
