import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { StoreDb } from "./index.ts";
import { revision } from "./business.ts";
import { rebasePristineReplication } from "./replication.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { households, hosts, memberInvites, members } from "./schema/identity.ts";
import { peers } from "./schema/peers.ts";
import { changeLog, peerCursors } from "./schema/replication.ts";

export type PeerRecord = typeof peers.$inferSelect;
type ApprovedPeer = Pick<PeerRecord,
  "hostId" | "householdId" | "joinFromHouseholdId" | "addressHost" | "addressPort"
  | "caCertificate" | "fingerprint" | "protocolVersion"
>;

export class PeerHouseholdConflict extends Error {
  constructor() {
    super("只有尚未使用的宿主能加入另一个家庭");
  }
}

export function getPeer(db: Pick<StoreDb, "select">, hostId: string) {
  return db.select().from(peers).where(eq(peers.hostId, hostId)).get();
}

export function peerForCertificate(db: StoreDb, householdId: string, fingerprint: string) {
  return db.select().from(peers).where(and(
    eq(peers.fingerprint, fingerprint), eq(peers.householdId, householdId), isNull(peers.revokedAt),
  )).get();
}

export function listPeers(db: StoreDb, householdId: string) {
  return db.select().from(peers).where(eq(peers.householdId, householdId)).orderBy(asc(peers.hostId)).all();
}

export function approvePeer(db: Pick<StoreDb, "transaction">, clock: Clock, peer: ApprovedPeer): PeerRecord {
  return db.transaction((tx) => {
    const before = getPeer(tx, peer.hostId);
    const sameCredential = before && before.householdId === peer.householdId
      && before.fingerprint === peer.fingerprint && before.revokedAt === null
      && before.joinFromHouseholdId === peer.joinFromHouseholdId;
    const state = {
      ...peer,
      protocolVersion: sameCredential && before.confirmedAt !== null ? before.protocolVersion : peer.protocolVersion,
      joinPreparedAt: sameCredential ? before.joinPreparedAt : null,
      confirmedLocalFingerprint: sameCredential ? before.confirmedLocalFingerprint : null,
      approvedAt: sameCredential ? before.approvedAt : clock.wallMs(),
      approvalId: (sameCredential ? before.approvalId : null) ?? crypto.randomUUID(),
      confirmedAt: sameCredential ? before.confirmedAt : null,
      revokedAt: null,
    };
    return tx.insert(peers).values(state)
      .onConflictDoUpdate({ target: peers.hostId, set: state }).returning().get()!;
  }, { behavior: "immediate" });
}

export function preparePeerJoin(db: StoreDb, clock: Clock, hostId: string): void {
  db.update(peers).set({ joinPreparedAt: clock.wallMs() }).where(eq(peers.hostId, hostId)).run();
}

export function confirmPeer(db: StoreDb, clock: Clock, peer: PeerRecord, protocolVersion: number, localFingerprint: string) {
  return db.update(peers).set({
    protocolVersion, confirmedAt: clock.wallMs(), confirmedLocalFingerprint: localFingerprint,
    joinFromHouseholdId: null, joinPreparedAt: null,
  })
    .where(and(eq(peers.hostId, peer.hostId), eq(peers.householdId, peer.householdId),
      eq(peers.fingerprint, peer.fingerprint), isNull(peers.revokedAt))).returning().get();
}

export function revokePeer(db: StoreDb, clock: Clock, householdId: string, hostId: string): void {
  db.update(peers).set({ revokedAt: clock.wallMs() }).where(and(
    eq(peers.hostId, hostId), eq(peers.householdId, householdId), isNull(peers.revokedAt),
  )).run();
}

export function setPeerPullPaused(db: StoreDb, householdId: string, hostId: string, paused: boolean) {
  return db.update(peers).set({ pullPaused: paused }).where(and(
    eq(peers.hostId, hostId), eq(peers.householdId, householdId), isNull(peers.revokedAt),
  )).returning().get();
}

export function requirePristineHousehold(db: Pick<StoreDb, "select">, hostId: string, householdId: string) {
  const household = db.select().from(households).where(eq(households.id, householdId)).get();
  const localHost = db.select().from(hosts).where(eq(hosts.id, hostId)).get();
  const group = db.select().from(conversations).where(eq(conversations.householdId, householdId)).all();
  if (household?.originHostId !== hostId || household.deletedAt !== null || localHost?.householdId !== householdId
    || localHost.rev !== 1 || localHost.deletedAt !== null
    || db.select().from(hosts).where(eq(hosts.householdId, householdId)).all().length !== 1
    || db.select().from(members).where(eq(members.householdId, householdId)).limit(1).get()
    || db.select().from(memberInvites).where(eq(memberInvites.householdId, householdId)).limit(1).get()
    || db.select().from(peers).where(eq(peers.householdId, householdId)).limit(1).get()
    || db.select().from(peerCursors).where(eq(peerCursors.householdId, householdId)).limit(1).get()
    || db.select().from(changeLog).where(and(
      eq(changeLog.sourceHostId, hostId), notInArray(changeLog.kind, ["household", "host", "conversation"]),
    )).limit(1).get()
    || group.length !== 1 || group[0]?.kind !== "group" || group[0].publisherHostId !== hostId
    || group[0].originHostId !== hostId
    || group[0].rev !== 1 || group[0].deletedAt !== null
    || db.select().from(messages).where(eq(messages.conversationId, group[0].id)).limit(1).get()
    || db.select().from(participants).where(eq(participants.conversationId, group[0].id)).limit(1).get()) {
    throw new PeerHouseholdConflict();
  }
  return group[0].id;
}

export function joinPeerHousehold(
  db: StoreDb,
  clock: Clock,
  localHostId: string,
  previousHouseholdId: string,
  household: typeof households.$inferInsert,
  peer: ApprovedPeer,
) {
  return db.transaction((tx) => {
    const provisionalGroup = requirePristineHousehold(tx, localHostId, previousHouseholdId);
    tx.insert(households).values(household).run();
    tx.update(hosts).set({ householdId: household.id, ...revision(clock), rev: 2 })
      .where(eq(hosts.id, localHostId)).run();
    tx.delete(conversations).where(eq(conversations.id, provisionalGroup)).run();
    tx.delete(households).where(eq(households.id, previousHouseholdId)).run();
    rebasePristineReplication(tx, localHostId, household.id);
    return approvePeer(tx, clock, peer);
  }, { behavior: "immediate" });
}
