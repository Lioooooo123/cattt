import { and, eq } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { PeerBehaviorEnvelope, PeerReceipt } from "../peer-behavior/protocol.ts";
import type { Store, StoreDb } from "./index.ts";
import { writeTransaction } from "./index.ts";
import { completeJob, failJob } from "./jobs.ts";
import type { JobAttempt } from "./jobs.ts";
import { peerInbox, peerOutbox } from "./schema/peer-behavior.ts";

export type PeerBehaviorTransaction = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];
export type PeerDelivery = Omit<typeof peerOutbox.$inferSelect, "envelope" | "receipt"> & {
  envelope: PeerBehaviorEnvelope;
  receipt: PeerReceipt | null;
};

type ReadDb = Pick<StoreDb, "select">;

function delivery(row: typeof peerOutbox.$inferSelect): PeerDelivery {
  return {
    ...row,
    envelope: JSON.parse(row.envelope) as PeerBehaviorEnvelope,
    receipt: row.receipt === null ? null : JSON.parse(row.receipt) as PeerReceipt,
  };
}

export function getPeerDelivery(db: ReadDb, id: string): PeerDelivery | undefined {
  const row = db.select().from(peerOutbox).where(eq(peerOutbox.id, id)).get();
  return row && delivery(row);
}

export function findPeerDelivery(db: ReadDb, envelope: Pick<PeerBehaviorEnvelope, "household_id" | "target_host_id" | "idempotency_key">): PeerDelivery | undefined {
  const row = db.select().from(peerOutbox).where(and(
    eq(peerOutbox.householdId, envelope.household_id),
    eq(peerOutbox.targetHostId, envelope.target_host_id),
    eq(peerOutbox.idempotencyKey, envelope.idempotency_key),
  )).get();
  return row && delivery(row);
}

export function insertPeerDelivery(
  tx: PeerBehaviorTransaction,
  input: Omit<PeerDelivery, "status" | "receipt" | "rejectionCode" | "settledAt">,
): PeerDelivery {
  const row = tx.insert(peerOutbox).values({
    ...input,
    envelope: JSON.stringify(input.envelope),
    status: "pending",
  }).returning().get()!;
  return delivery(row);
}

export function getPeerAdmission(db: ReadDb, envelope: Pick<PeerBehaviorEnvelope, "household_id" | "idempotency_key">, sourceHostId: string) {
  const row = db.select().from(peerInbox).where(and(
    eq(peerInbox.householdId, envelope.household_id),
    eq(peerInbox.sourceHostId, sourceHostId),
    eq(peerInbox.idempotencyKey, envelope.idempotency_key),
  )).get();
  return row && { requestHash: row.requestHash, receipt: JSON.parse(row.receipt) as PeerReceipt };
}

export function insertPeerAdmission(tx: PeerBehaviorTransaction, receipt: PeerReceipt): void {
  tx.insert(peerInbox).values({
    householdId: receipt.household_id,
    sourceHostId: receipt.source_host_id,
    idempotencyKey: receipt.idempotency_key,
    requestHash: receipt.request_hash,
    receipt: JSON.stringify(receipt),
  }).run();
}

export function settlePeerDelivery(
  store: Store,
  clock: Clock,
  attempt: JobAttempt,
  deliveryId: string,
  result: { receipt: PeerReceipt; confirm?: (tx: Pick<StoreDb, "select" | "transaction">) => void } | { rejection: string },
): void {
  writeTransaction(store, (db) => {
    const now = clock.wallMs();
    const accepted = "receipt" in result;
    const held = accepted
      ? completeJob(db, clock, attempt)
      : failJob(db, clock, attempt, result.rejection, now, true);
    if (!held) {
      return;
    }
    if (accepted) {
      result.confirm?.(db);
    }
    const changed = db.update(peerOutbox).set({
      status: accepted ? "delivered" : "rejected",
      receipt: accepted ? JSON.stringify(result.receipt) : null,
      rejectionCode: accepted ? null : result.rejection,
      settledAt: now,
    }).where(and(eq(peerOutbox.id, deliveryId), eq(peerOutbox.jobId, attempt.id),
      eq(peerOutbox.status, "pending"))).returning({ id: peerOutbox.id }).get();
    if (!changed) {
      throw new Error("Peer 投递与作业状态不一致");
    }
  });
}
