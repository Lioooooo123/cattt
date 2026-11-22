import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";
import { AccessDeniedError } from "../identity/access.ts";
import { DEFAULT_MAX_MEMBERS } from "../runtime/config.ts";
import { failedCode, generateCode, hashCode, liveCode, normalizeCode } from "./codes.ts";
import { findGroup } from "./conversation-lifecycle.ts";
import { getHostMeta } from "./host-meta.ts";
import { createDevice, getHousehold, getMember, insertAdmittedMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { activeMembers, assertCreatorSeatCapacity, INVITE_TTL_MS, MemberSeatAuthorityPendingError } from "./member-seats.ts";
import { getPeerCursor } from "./replication.ts";
import { hosts, memberInvites } from "./schema/identity.ts";

export { INVITE_TTL_MS } from "./member-seats.ts";

export class MemberBootstrapError extends Error {
  constructor() {
    super("只有家庭创建宿主能引导首成员，后续成员须通过邀请加入");
    this.name = "MemberBootstrapError";
  }
}

export class MemberSyncPendingError extends Error {
  constructor() {
    super("等待家庭创建宿主的成员和群聊同步完成");
    this.name = "MemberSyncPendingError";
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

function requireJoinedHouseholdReady(db: Pick<StoreDb, "select">, householdId: string, hostId: string) {
  const family = getHousehold(db, householdId)!;
  if (family.originHostId !== hostId && (!getPeerCursor(db, family.originHostId)
    || findGroup(db, householdId)?.deletedAt !== null || activeMembers(db, householdId) === 0)) {
    throw new MemberSyncPendingError();
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
    const household = getHousehold(tx, input.householdId);
    if (household?.originHostId !== host.id || activeMembers(tx, input.householdId) !== 0) {
      throw new MemberBootstrapError();
    }
    assertCreatorSeatCapacity(tx, input.householdId, wallMs(clock), max, "allocate");
    const memberId = insertAdmittedMember(tx, clock, {
      householdId: input.householdId, displayName: input.displayName.trim(), homeHostId: host.id,
    });
    return getMember(tx, memberId)!;
  }, { behavior: "immediate" });
}

type IssueInput = { householdId: string; displayName?: string; invitedByMemberId?: string; maxMembers?: number };

export function issueMemberInvite(db: Pick<StoreDb, "transaction">, clock: Clock, input: IssueInput) {
  return makeInvite(db, clock, input, false);
}

// Persist the intended home membership before asking the creator for a grant.
// The route returns the code only after the creator commits the reservation.
export function prepareJoinedMemberInvite(db: Pick<StoreDb, "transaction">, clock: Clock, input: IssueInput) {
  return makeInvite(db, clock, input, true);
}

function makeInvite(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: IssueInput,
  prepareJoined: boolean,
) {
  if (input.displayName !== undefined) {
    requireName(input.displayName);
  }
  const max = limit(input.maxMembers);
  return db.transaction((tx) => {
    const host = localHost(tx, input.householdId);
    requireJoinedHouseholdReady(tx, input.householdId, host.id);
    const originHostId = getHousehold(tx, input.householdId)!.originHostId;
    const joined = originHostId !== host.id;
    if (joined && !prepareJoined) throw new MemberSeatAuthorityPendingError();
    if (!joined && prepareJoined) throw new AccessDeniedError();
    if (input.invitedByMemberId !== undefined) {
      const inviter = getMember(tx, input.invitedByMemberId);
      if (inviter?.householdId !== input.householdId) {
        throw new AccessDeniedError();
      }
    }
    const now = wallMs(clock);
    if (!joined) assertCreatorSeatCapacity(tx, input.householdId, now, max, "allocate");
    const issued = generateCode((hash) => tx.select({ id: memberInvites.id }).from(memberInvites)
      .where(eq(memberInvites.codeHash, hash)).get() !== undefined);
    const expiresAt = now + INVITE_TTL_MS;
    validateWallMs(expiresAt);
    const inviteId = uuidv7(clock);
    const seatMemberId = joined ? uuidv7(clock) : null;
    tx.insert(memberInvites).values({
      id: inviteId, householdId: input.householdId, displayName: input.displayName?.trim() ?? null,
      codeHash: issued.codeHash, invitedByMemberId: input.invitedByMemberId ?? null,
      expiresAt, usedAt: null, revokedAt: null, failures: 0, createdAt: now, seatMemberId,
    }).run();
    return { inviteId, code: issued.code, expiresAt, seatMemberId };
  }, { behavior: "immediate" });
}

function findLiveInvite(db: Pick<StoreDb, "select">, normalized: string, now: number) {
  return db.select().from(memberInvites).where(and(
    liveCode(memberInvites, now), eq(memberInvites.codeHash, hashCode(normalized)),
  )).get();
}

type ConfirmedSeat = { memberId: string; inviteId: string };

export function memberInviteAdmission(db: Pick<StoreDb, "select">, clock: Clock, code: string) {
  const normalized = normalizeCode(code);
  const invite = normalized && findLiveInvite(db, normalized, wallMs(clock));
  if (!invite) return undefined;
  const host = localHost(db, invite.householdId);
  const localAuthority = getHousehold(db, invite.householdId)!.originHostId === host.id;
  if (!localAuthority) requireJoinedHouseholdReady(db, invite.householdId, host.id);
  const seat = invite.seatMemberId ? { memberId: invite.seatMemberId, inviteId: invite.id } : undefined;
  return { localAuthority, seat };
}

export function acceptMemberInvite(
  db: Pick<StoreDb, "transaction">,
  clock: Clock,
  input: {
    code: string; displayName: string; deviceName: string; maxMembers?: number;
    confirmedSeat?: ConfirmedSeat;
  },
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
    const invite = findLiveInvite(tx, normalized, now);
    if (!invite) {
      tx.update(memberInvites).set(failedCode(memberInvites)).where(liveCode(memberInvites, now)).run();
      return undefined;
    }
    const host = localHost(tx, invite.householdId);
    requireJoinedHouseholdReady(tx, invite.householdId, host.id);
    const household = getHousehold(tx, invite.householdId)!;
    if (household.originHostId === host.id) {
      assertCreatorSeatCapacity(tx, invite.householdId, now, max, "use_local");
    } else if (!invite.seatMemberId || input.confirmedSeat?.memberId !== invite.seatMemberId
      || input.confirmedSeat.inviteId !== invite.id) {
      throw new MemberSeatAuthorityPendingError();
    }
    const memberId = insertAdmittedMember(tx, clock, {
      householdId: invite.householdId, displayName: input.displayName.trim(),
      homeHostId: host.id, memberId: invite.seatMemberId ?? undefined,
    });
    const device = createDevice(tx, clock, { memberId, hostId: host.id, name: input.deviceName.trim() });
    tx.update(memberInvites).set({ usedAt: now }).where(eq(memberInvites.id, invite.id)).run();
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

export function listOpenMemberInvites(db: Pick<StoreDb, "select">, clock: Clock, householdId: string) {
  return db.select({
    id: memberInvites.id, display_name: memberInvites.displayName, expires_at: memberInvites.expiresAt,
  }).from(memberInvites).where(and(
    eq(memberInvites.householdId, householdId), liveCode(memberInvites, wallMs(clock)),
  )).orderBy(memberInvites.id).all();
}
