import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { PeerActor } from "../peer/protocol.ts";
import { LEASE_MS, PUBLICATION_PEER_VERSION, PublicationLeaseError } from "../publication/types.ts";
import type { HandoffReceipt, PublicationFence, PublicationProof, RenewalRequest } from "../publication/types.ts";
import type { PublicationWindow } from "../publication/window.ts";
import { getHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import type { PeerRecord } from "./peers.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { hosts, households } from "./schema/identity.ts";
import { peers } from "./schema/peers.ts";
import { publicationEpochs, publicationRenewals } from "./schema/publication.ts";
import { turns } from "./schema/turns.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { catFactPublicationHistory } from "./cat-fact-replica.ts";
import { worldPublicationHistory } from "./world-replicas.ts";
import { groupTicketHistory } from "./ticket-replica-records.ts";
import { turnEvent } from "./turn-writes.ts";
import type { Append } from "./turn-writes.ts";

type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "transaction">;
type EpochRow = typeof publicationEpochs.$inferSelect;
type MessageRow = Omit<typeof messages.$inferSelect, "turnId">;

function epochRow(db: Reader, householdId: string, epoch: number) {
  return db.select().from(publicationEpochs).where(and(
    eq(publicationEpochs.householdId, householdId), eq(publicationEpochs.epoch, epoch),
  )).get();
}

export function publicationProof(db: Reader, householdId: string, epoch?: number): PublicationProof | undefined {
  if (epoch === undefined) {
    const last = db.select().from(publicationEpochs).where(eq(publicationEpochs.householdId, householdId))
      .orderBy(desc(publicationEpochs.epoch)).limit(1).get();
    if (last) return last;
  } else if (epoch !== 1) {
    return epochRow(db, householdId, epoch);
  }
  const family = db.select().from(households).where(and(eq(households.id, householdId), isNull(households.deletedAt))).get();
  return family && { householdId, epoch: 1, grantId: householdId, holderHostId: family.originHostId };
}

export function publicationCredential(proof: PublicationFence): string {
  return `leased:${proof.epoch}:${proof.grantId}`;
}

export function publicationIsSealed(db: Reader, householdId: string, epoch: number): boolean {
  return epochRow(db, householdId, epoch + 1) !== undefined;
}

function knownPeers(db: Reader, householdId: string) {
  return db.select().from(peers).where(eq(peers.householdId, householdId)).limit(2).all();
}

export function publicationPeer(db: Reader, householdId: string): PeerRecord | undefined {
  const all = knownPeers(db, householdId);
  const peer = all[0];
  return all.length === 1 && peer?.revokedAt === null && peer.confirmedAt !== null
    && peer.confirmedLocalFingerprint !== null && peer.protocolVersion >= PUBLICATION_PEER_VERSION ? peer : undefined;
}

export function publicationPeerBinding(peer: PeerRecord): string {
  return JSON.stringify([peer.hostId, peer.fingerprint, peer.approvalId, peer.confirmedLocalFingerprint, peer.protocolVersion]);
}

export function readPublicationRoute(db: Reader, householdId: string, window?: PublicationWindow) {
  const current = publicationProof(db, householdId);
  const local = getHostMeta(db, "host_id");
  if (!current || !local) return { current, status: "waiting" as const };
  if (current.holderHostId !== local) return { current, status: "remote" as const };

  const otherHost = db.select({ id: hosts.id }).from(hosts).where(and(
    eq(hosts.householdId, householdId), sql`${hosts.id} <> ${local}`,
  )).limit(1).get();
  if (current.epoch === 1 && !otherHost && knownPeers(db, householdId).length === 0) {
    return { current, status: "ready" as const };
  }
  const peer = publicationPeer(db, householdId);
  const valid = peer && window?.valid(current, publicationPeerBinding(peer));
  return { current, status: valid ? "ready" as const : "waiting" as const };
}

// Call on the write transaction, with the fence captured before async work.
// New synchronously admitted writes may omit expected and use the returned fence.
export function requireSharedPublisher(
  db: Reader, householdId: string, window?: PublicationWindow, expected?: PublicationFence | number,
): PublicationProof {
  const { current, status } = readPublicationRoute(db, householdId, window);
  if (status === "remote") throw new PublicationLeaseError("not_publisher");
  if (status !== "ready" || !current) throw new PublicationLeaseError("publication_lease_pending");
  if (typeof expected === "number" ? current.epoch !== expected
    : expected && (current.epoch !== expected.epoch || current.grantId !== expected.grantId)) {
    throw new PublicationLeaseError("publication_epoch_conflict");
  }
  return current;
}

function authenticatedPeer(db: Reader, actor: PeerActor, localFingerprint: string, householdId: string) {
  const peer = publicationPeer(db, householdId);
  if (!peer || actor.access !== "read_write" || actor.householdId !== householdId
    || actor.hostId !== peer.hostId || actor.fingerprint !== peer.fingerprint || actor.protocolVersion !== peer.protocolVersion
    || peer.confirmedLocalFingerprint !== localFingerprint) {
    throw new PublicationLeaseError("publication_peer_ineligible");
  }
  return peer;
}

function groupId(db: Reader, householdId: string) {
  return db.select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.householdId, householdId), eq(conversations.kind, "group"), isNull(conversations.deletedAt),
  )).get()?.id;
}

export function messagePublicationFact(row: MessageRow): readonly unknown[] {
  return [
    row.id, row.originHostId, row.conversationId, row.authorMemberId, row.clientMessageId, row.replyToMessageId,
    row.publicationEpoch, row.text, row.modality, row.status, row.hlc, row.rev, row.createdAt, row.updatedAt, row.deletedAt,
  ];
}

function historyDigest(db: ReplicationTx, id: string, epoch: number): string {
  const rows = db.select().from(messages).where(and(
    eq(messages.conversationId, id), sql`coalesce(${messages.publicationEpoch}, 1) = ${epoch}`,
  )).orderBy(asc(messages.id)).all();
  const hash = createHash("sha256");
  for (const row of rows) hash.update(JSON.stringify(messagePublicationFact(row))).update("\n");
  for (const record of groupTicketHistory(db, id, epoch)) hash.update(JSON.stringify(record)).update("\n");
  const group = db.select({ householdId: conversations.householdId }).from(conversations).where(eq(conversations.id, id)).get()!;
  for (const record of worldPublicationHistory(db, group.householdId, epoch)) hash.update(JSON.stringify(record)).update("\n");
  for (const record of catFactPublicationHistory(db, group.householdId, epoch)) hash.update(JSON.stringify(record)).update("\n");
  return hash.digest("hex");
}

function handoffDto(row: EpochRow): HandoffReceipt {
  return {
    request_id: row.grantId, household_id: row.householdId, epoch: row.epoch, holder_host_id: row.holderHostId,
    previous_holder_host_id: row.previousHolderHostId, previous_grant_id: row.previousGrantId, history_digest: row.historyDigest,
  };
}

export function pendingPublicationTransfer(db: Reader, householdId: string, localHostId: string) {
  const current = publicationProof(db, householdId);
  const row = current && epochRow(db, householdId, current.epoch);
  return row && row.previousHolderHostId === localHostId && !row.acknowledged ? {
    request_id: row.grantId, expected_epoch: row.epoch - 1, target_host_id: row.holderHostId,
  } : null;
}

function savedGrant(db: Reader, householdId: string, requestId: string) {
  return db.select().from(publicationEpochs).where(and(
    eq(publicationEpochs.householdId, householdId), eq(publicationEpochs.grantId, requestId),
  )).get();
}

export function preparePublicationTransfer(
  db: Writer, clock: Clock, householdId: string, localHostId: string, targetHostId: string, localFingerprint: string,
  requestId: string, expectedEpoch: number, append?: Append,
  beforeSeal?: (tx: ReplicationTx, current: PublicationProof) => void,
) {
  return db.transaction((tx) => {
    const existing = savedGrant(tx, householdId, requestId);
    if (existing && (existing.previousHolderHostId !== localHostId || existing.holderHostId !== targetHostId
      || existing.epoch !== expectedEpoch + 1)) {
      throw new PublicationLeaseError("publication_request_conflict");
    }
    if (existing?.acknowledged) return { receipt: handoffDto(existing), acknowledged: true };

    const peer = publicationPeer(tx, householdId);
    if (!peer || peer.hostId !== targetHostId || peer.confirmedLocalFingerprint !== localFingerprint) {
      throw new PublicationLeaseError("publication_peer_ineligible");
    }
    if (existing) return { receipt: handoffDto(existing), acknowledged: false };

    const current = publicationProof(tx, householdId);
    if (!current || current.epoch !== expectedEpoch) throw new PublicationLeaseError("publication_epoch_conflict");
    if (current.holderHostId !== localHostId) throw new PublicationLeaseError("not_publisher");
    const conversationId = groupId(tx, householdId);
    if (!conversationId) throw new PublicationLeaseError("publication_history_pending");
    beforeSeal?.(tx, current);

    // End the old stream with an error in the same commit that stops the
    // writer. The previously emitted draft must never become a reply.
    const activeTurns = tx.select({ id: turns.id }).from(turns).where(and(
      eq(turns.conversationId, conversationId), inArray(turns.status, ["queued", "generating"]),
    )).all();
    for (const turn of activeTurns) {
      tx.update(turns).set({
        status: "failed", errorCode: "publication_changed", finishedAt: clock.wallMs(), draftText: "",
      }).where(eq(turns.id, turn.id)).run();
      turnEvent(tx, clock, turn.id, {
        kind: "error", data: { code: "publication_changed", retryable: true }, terminal: true,
      }, append);
    }
    const row = tx.insert(publicationEpochs).values({
      householdId, epoch: expectedEpoch + 1, grantId: requestId, holderHostId: targetHostId,
      previousHolderHostId: localHostId, previousGrantId: current.grantId,
      historyDigest: historyDigest(tx, conversationId, expectedEpoch), acknowledged: false,
    }).returning().get()!;
    return { receipt: handoffDto(row), acknowledged: false };
  }, { behavior: "immediate" });
}

export function acceptPublicationTransfer(
  db: Writer, actor: PeerActor, localHostId: string, localFingerprint: string, receipt: HandoffReceipt,
): HandoffReceipt {
  return db.transaction((tx) => {
    authenticatedPeer(tx, actor, localFingerprint, receipt.household_id);
    if (receipt.previous_holder_host_id !== actor.hostId || receipt.holder_host_id !== localHostId) {
      throw new PublicationLeaseError("publication_peer_ineligible");
    }
    const existing = savedGrant(tx, receipt.household_id, receipt.request_id);
    if (existing) {
      const stored = handoffDto(existing);
      if (JSON.stringify(stored) !== JSON.stringify(receipt)) throw new PublicationLeaseError("publication_request_conflict");
      return stored;
    }
    const current = publicationProof(tx, receipt.household_id);
    if (!current || receipt.epoch !== current.epoch + 1 || receipt.previous_grant_id !== current.grantId
      || current.holderHostId !== actor.hostId) {
      throw new PublicationLeaseError("publication_epoch_conflict");
    }
    const conversationId = groupId(tx, receipt.household_id);
    if (!conversationId || historyDigest(tx, conversationId, current.epoch) !== receipt.history_digest) {
      throw new PublicationLeaseError("publication_history_pending");
    }
    tx.insert(publicationEpochs).values({
      householdId: receipt.household_id, epoch: receipt.epoch, grantId: receipt.request_id, holderHostId: localHostId,
      previousHolderHostId: actor.hostId, previousGrantId: current.grantId, historyDigest: receipt.history_digest,
      acknowledged: true,
    }).run();
    return receipt;
  }, { behavior: "immediate" });
}

export function acknowledgePublicationTransfer(db: Writer, receipt: HandoffReceipt) {
  db.transaction((tx) => {
    tx.update(publicationEpochs).set({ acknowledged: true }).where(and(
      eq(publicationEpochs.householdId, receipt.household_id), eq(publicationEpochs.epoch, receipt.epoch),
      eq(publicationEpochs.grantId, receipt.request_id),
    )).run();
  }, { behavior: "immediate" });
}

function latestRenewal(db: Reader, householdId: string, epoch: number) {
  return db.select().from(publicationRenewals).where(and(
    eq(publicationRenewals.householdId, householdId), eq(publicationRenewals.epoch, epoch),
  )).get();
}

function saveRenewal(db: Pick<StoreDb, "insert">, request: RenewalRequest) {
  const row = {
    householdId: request.household_id, epoch: request.epoch, sequence: request.sequence, requestId: request.request_id,
  };
  db.insert(publicationRenewals).values(row).onConflictDoUpdate({
    target: [publicationRenewals.householdId, publicationRenewals.epoch],
    set: { sequence: row.sequence, requestId: row.requestId },
  }).run();
}

export function beginPublicationRenewal(
  db: Writer, proof: PublicationProof, peerBinding: string,
): RenewalRequest | undefined {
  return db.transaction((tx) => {
    const current = publicationProof(tx, proof.householdId);
    const peer = publicationPeer(tx, proof.householdId);
    if (!current || current.holderHostId !== getHostMeta(tx, "host_id") || current.epoch !== proof.epoch
      || current.grantId !== proof.grantId || !peer || publicationPeerBinding(peer) !== peerBinding) return undefined;
    const renewal: RenewalRequest = {
      household_id: proof.householdId, epoch: proof.epoch, grant_id: proof.grantId,
      sequence: (latestRenewal(tx, proof.householdId, proof.epoch)?.sequence ?? 0) + 1, request_id: crypto.randomUUID(),
    };
    saveRenewal(tx, renewal);
    return renewal;
  }, { behavior: "immediate" });
}

export function issuePublicationRenewal(
  db: Writer, actor: PeerActor, localFingerprint: string, request: RenewalRequest,
) {
  return db.transaction((tx) => {
    authenticatedPeer(tx, actor, localFingerprint, request.household_id);
    const current = publicationProof(tx, request.household_id);
    if (!current || current.epoch !== request.epoch || current.grantId !== request.grant_id
      || current.holderHostId !== actor.hostId) {
      throw new PublicationLeaseError("publication_epoch_conflict");
    }
    const last = latestRenewal(tx, request.household_id, request.epoch);
    if (last && (request.sequence < last.sequence || (request.sequence === last.sequence && request.request_id !== last.requestId))) {
      throw new PublicationLeaseError("publication_request_conflict");
    }
    if (request.sequence !== last?.sequence) saveRenewal(tx, request);
    return { ...request, holder_host_id: actor.hostId, ttl_ms: LEASE_MS };
  }, { behavior: "immediate" });
}
