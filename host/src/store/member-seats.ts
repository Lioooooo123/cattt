import { and, count, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { AccessDeniedError } from "../identity/access.ts";
import { getPeer } from "./peers.ts";
import { getHostMeta } from "./host-meta.ts";
import { getHousehold, MemberLimitError } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { CODE_MAX_FAILURES, liveCode } from "./codes.ts";
import { memberInvites, members, memberSeatGrants as grants, memberSeatLegacyPeers as legacy } from "./schema/identity.ts";

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export class MemberSeatAuthorityPendingError extends Error {
  constructor() {
    super("等待家庭创建宿主确认成员名额，请稍后重试");
    this.name = "MemberSeatAuthorityPendingError";
  }
}

export class MemberSeatUnavailableError extends Error {
  constructor() {
    super("该邀请的家庭名额已失效");
    this.name = "MemberSeatUnavailableError";
  }
}

type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "transaction">;
type Grant = typeof grants.$inferSelect;
type Scope = Pick<Grant, "householdId" | "peerHostId">;
type Seat = Scope & Pick<Grant, "memberId">;

function assertCreator(db: Reader, householdId: string) {
  const local = getHostMeta(db, "host_id");
  if (!local || getHousehold(db, householdId)?.originHostId !== local) throw new AccessDeniedError();
  return local;
}

function requireJoinedPeer(db: Reader, scope: Scope) {
  const creator = assertCreator(db, scope.householdId);
  const peer = getPeer(db, scope.peerHostId);
  if (scope.peerHostId === creator || peer?.householdId !== scope.householdId
    || peer.revokedAt !== null || peer.confirmedAt === null) throw new AccessDeniedError();
}

export function activeMembers(db: Reader, householdId: string): number {
  return db.select({ count: count() }).from(members).where(and(
    eq(members.householdId, householdId), isNull(members.deletedAt),
  )).get()!.count;
}

function openGrants(db: Reader, householdId: string, now: number) {
  return db.select({ memberId: grants.memberId, peerHostId: grants.peerHostId })
    .from(grants).leftJoin(members, and(
      eq(members.id, grants.memberId), eq(members.originHostId, grants.peerHostId),
    )).where(and(
      eq(grants.householdId, householdId), isNull(grants.releasedAt), isNull(members.deletedAt),
      or(isNotNull(grants.confirmedAt), gt(grants.expiresAt, now)),
    )).all();
}

export function assertCreatorSeatCapacity(
  db: Pick<StoreDb, "select" | "update">, householdId: string, now: number, max: number,
  mode: "allocate" | "use_local" | "use_grant",
) {
  assertCreator(db, householdId);
  if (db.select().from(legacy).where(eq(legacy.householdId, householdId)).limit(1).get()) {
    throw new MemberSeatAuthorityPendingError();
  }
  // Persist expiry before another allocation can reuse the seat. A grant already
  // confirmed to its home host needs proof of retirement from that host.
  db.update(grants).set({ releasedAt: now }).where(and(
    eq(grants.householdId, householdId), isNull(grants.releasedAt),
    isNull(grants.confirmedAt), lte(grants.expiresAt, now),
  )).run();
  const untrackedMembers = db.select({ count: count() }).from(members).leftJoin(grants, and(
    eq(grants.memberId, members.id), eq(grants.householdId, members.householdId), eq(grants.peerHostId, members.originHostId),
  ))
    .where(and(eq(members.householdId, householdId), isNull(members.deletedAt), isNull(grants.memberId))).get()!.count;
  const pendingLocal = mode === "allocate" ? db.select({ count: count() }).from(memberInvites)
    .where(and(eq(memberInvites.householdId, householdId), liveCode(memberInvites, now))).get()!.count : 0;
  const occupied = untrackedMembers + openGrants(db, householdId, now).length + pendingLocal;
  if (mode === "use_grant" ? occupied > max : occupied >= max) throw new MemberLimitError(max);
}

export function reserveJoinedMemberSeat(db: Writer, clock: Clock, seat: Seat, maxMembers: number) {
  db.transaction((tx) => {
    requireJoinedPeer(tx, seat);
    const now = clock.wallMs();
    const expiresAt = now + INVITE_TTL_MS;
    validateWallMs(expiresAt);
    const existing = tx.select().from(grants).where(eq(grants.memberId, seat.memberId)).get();
    if (existing || tx.select({ id: members.id }).from(members).where(eq(members.id, seat.memberId)).get()) {
      throw new MemberSeatUnavailableError();
    }
    assertCreatorSeatCapacity(tx, seat.householdId, now, maxMembers, "allocate");
    tx.insert(grants).values({ ...seat, expiresAt }).run();
  }, { behavior: "immediate" });
}

export function confirmJoinedMemberSeat(db: Writer, clock: Clock, seat: Seat, maxMembers: number) {
  db.transaction((tx) => {
    requireJoinedPeer(tx, seat);
    const now = clock.wallMs();
    const grant = tx.select().from(grants).where(and(
      eq(grants.memberId, seat.memberId), eq(grants.householdId, seat.householdId), eq(grants.peerHostId, seat.peerHostId),
    )).get();
    if (!grant || grant.releasedAt !== null || grant.expiresAt === null
      || (grant.confirmedAt === null && grant.expiresAt <= now)) throw new MemberSeatUnavailableError();
    if (tx.select({ id: members.id }).from(members).where(and(eq(members.id, seat.memberId),
      isNotNull(members.deletedAt))).get()) throw new MemberSeatUnavailableError();
    assertCreatorSeatCapacity(tx, seat.householdId, now, maxMembers, "use_grant");
    if (grant.confirmedAt === null) tx.update(grants).set({ confirmedAt: now }).where(eq(grants.memberId, seat.memberId)).run();
  }, { behavior: "immediate" });
}

export function creatorSeatInspections(db: Reader, clock: Clock, householdId: string) {
  assertCreator(db, householdId);
  const peers = new Map<string, { legacy: boolean; memberIds: string[] }>();
  for (const { peerHostId } of db.select().from(legacy).where(eq(legacy.householdId, householdId)).all()) {
    peers.set(peerHostId, { legacy: true, memberIds: [] });
  }
  for (const { peerHostId, memberId } of openGrants(db, householdId, clock.wallMs())) {
    const inspection = peers.get(peerHostId) ?? { legacy: false, memberIds: [] };
    inspection.memberIds.push(memberId);
    peers.set(peerHostId, inspection);
  }
  return peers;
}

export function inspectJoinedMemberSeats(
  db: Pick<StoreDb, "select" | "transaction">, clock: Clock, householdId: string,
  input: { creatorHostId: string; memberIds: string[]; legacy: boolean },
) {
  const local = getHostMeta(db, "host_id");
  if (!local || local === input.creatorHostId || getHousehold(db, householdId)?.originHostId !== input.creatorHostId) {
    throw new AccessDeniedError();
  }
  return db.transaction((tx) => {
    const now = clock.wallMs();
    const native = tx.select({ id: members.id, deletedAt: members.deletedAt }).from(members).where(and(
      eq(members.householdId, householdId), eq(members.originHostId, local),
      input.legacy ? undefined : inArray(members.id, input.memberIds),
    )).all();
    const nativeById = new Map(native.map((member) => [member.id, member]));
    const retired: string[] = [];
    for (const id of input.memberIds) {
      const member = nativeById.get(id);
      if (member) {
        if (member.deletedAt !== null) retired.push(id);
        continue;
      }
      const invite = tx.select().from(memberInvites).where(and(
        eq(memberInvites.householdId, householdId), eq(memberInvites.seatMemberId, id),
      )).get();
      if (!invite || invite.usedAt !== null) continue;
      if (invite.revokedAt === null && invite.expiresAt > now && invite.failures < CODE_MAX_FAILURES) continue;
      // Fence clock rollback and pending redemption before reporting the seat free.
      if (invite.revokedAt === null) tx.update(memberInvites).set({ revokedAt: now })
        .where(eq(memberInvites.id, invite.id)).run();
      retired.push(id);
    }
    return { retired, legacyMemberIds: input.legacy ? native.filter((row) => row.deletedAt === null).map(({ id }) => id) : [] };
  }, { behavior: "immediate" });
}

export function recordCreatorSeatInspection(
  db: Writer, clock: Clock, scope: Scope, result: { retired: string[]; legacyMemberIds?: string[] },
) {
  db.transaction((tx) => {
    requireJoinedPeer(tx, scope);
    const now = clock.wallMs();
    for (const id of result.retired) {
      tx.update(grants).set({ releasedAt: now }).where(and(
        eq(grants.memberId, id), eq(grants.householdId, scope.householdId),
        eq(grants.peerHostId, scope.peerHostId), isNull(grants.releasedAt),
      )).run();
    }
    if (result.legacyMemberIds && tx.delete(legacy).where(and(
      eq(legacy.householdId, scope.householdId), eq(legacy.peerHostId, scope.peerHostId),
    )).returning().get()) {
      for (const memberId of result.legacyMemberIds) {
        tx.insert(grants).values({ ...scope, memberId, confirmedAt: now }).onConflictDoNothing().run();
      }
    }
  }, { behavior: "immediate" });
}
