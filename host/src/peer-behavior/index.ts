import { z } from "zod";
import { ChatEvents } from "../chat-events/index.ts";
import type { Clock } from "../clock/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { JobContext, JobRunner } from "../jobs/index.ts";
import type { PeerActor, PeerTransport } from "../peer/index.ts";
import { peerHostId } from "../peer/protocol.ts";
import type { Append } from "../store/turn-writes.ts";
import type { HostContext } from "../runtime/index.ts";
import type { StoreDb } from "../store/index.ts";
import { enqueueJob } from "../store/jobs.ts";
import {
  findPeerDelivery, getPeerAdmission, getPeerDelivery, insertPeerAdmission, insertPeerDelivery, settlePeerDelivery,
} from "../store/peer-behavior.ts";
import type { PeerBehaviorTransaction, PeerDelivery } from "../store/peer-behavior.ts";
import {
  behaviorEnvelope, behaviorKind, encodeEnvelope, inboxError, inboxRejection, matchesPeerReceipt,
  MAX_BEHAVIOR_BYTES, MAX_RECEIPT_BYTES, PEER_INBOX_VERSION, PeerBodyTooLarge, peerReceipt, readPeerJson,
} from "./protocol.ts";
import type {
  PeerBehaviorDraft, PeerBehaviorEnvelope, PeerBehaviorKind, PeerInboxError, PeerReceipt,
} from "./protocol.ts";

export const PEER_DELIVERY_QUEUE = "peer:deliver";
// Offline or unpaired hosts and late replicated sources can recover after days.
const deliveryAttempts = Number.MAX_SAFE_INTEGER;

interface BehaviorInput<T> {
  direction: "outbound" | "inbound";
  host: HostContext;
  envelope: PeerBehaviorEnvelope;
  sourceHostId: string;
  payload: T;
}

type Eligibility = "ready" | "waiting" | "rejected" | "stale" | "source_unavailable" | "revision_conflict";

interface Admission {
  id: string;
  wakeQueues?: readonly string[];
  memoryWrite?: PeerReceipt["memory_write"];
}

type ConfirmationDb = Pick<StoreDb, "select" | "transaction">;

export interface PeerBehaviorContract<T> {
  payload: z.ZodType<T>;
  inspect(db: Pick<StoreDb, "select">, input: BehaviorInput<T>): Eligibility;
  admit(tx: PeerBehaviorTransaction, clock: Clock, input: BehaviorInput<T>, append: Append): Admission;
  confirm?(tx: ConfirmationDb, clock: Clock, delivery: PeerDelivery, payload: T, receipt: PeerReceipt): void;
}

type Evaluation = {
  state: "ready";
  admit(tx: PeerBehaviorTransaction, clock: Clock, append: Append): Admission;
} | { state: Exclude<Eligibility, "ready"> | "invalid" };

type RegisteredBehavior = (
  db: Pick<StoreDb, "select">, input: Omit<BehaviorInput<unknown>, "payload">,
) => Evaluation;

type ReceiveResult =
  | { receipt: PeerReceipt; wakeQueues?: readonly string[] }
  | { error: PeerInboxError };

const replyError = z.object({
  error: z.object({ code: z.string().regex(/^peer_[a-z0-9_]{1,60}$/) }),
});

export class PeerBehaviorChannel {
  private readonly contracts = new Map<PeerBehaviorKind, RegisteredBehavior>();
  private readonly confirmations = new Map<PeerBehaviorKind, (
    tx: ConfirmationDb, clock: Clock, delivery: PeerDelivery, receipt: PeerReceipt,
  ) => void>();

  constructor(private readonly transport: () => PeerTransport | undefined) {}

  register<T>(kind: PeerBehaviorKind, contract: PeerBehaviorContract<T>): void {
    if (!behaviorKind.safeParse(kind).success || this.contracts.has(kind)) {
      throw new Error("Peer 行为必须在允许列表内且只能注册一次");
    }
    this.contracts.set(kind, (db, input) => {
      const parsed = contract.payload.safeParse(input.envelope.payload);
      if (!parsed.success) {
        return { state: "invalid" };
      }
      const behavior = { ...input, payload: parsed.data };
      const state = contract.inspect(db, behavior);
      return state === "ready"
        ? { state, admit: (tx, clock, append) => contract.admit(tx, clock, behavior, append) }
        : { state };
    });
    if (contract.confirm) {
      this.confirmations.set(kind, (tx, clock, delivery, receipt) => {
        contract.confirm!(tx, clock, delivery, contract.payload.parse(delivery.envelope.payload), receipt);
      });
    }
  }

  registerDelivery(jobs: JobRunner): void {
    jobs.register(PEER_DELIVERY_QUEUE, {
      schema: z.strictObject({ deliveryId: peerHostId }),
      concurrency: 1,
      timeoutMs: 15_000,
      maxAttempts: deliveryAttempts,
      handler: ({ deliveryId }, ctx) => this.deliver(ctx, deliveryId),
    });
  }

  // The caller inserts or reads its source in this same transaction.
  stage(ctx: HostContext, tx: PeerBehaviorTransaction, draft: PeerBehaviorDraft): PeerDelivery {
    const envelope = behaviorEnvelope.parse({
      inbox_version: PEER_INBOX_VERSION,
      household_id: ctx.householdId,
      target_host_id: draft.targetHostId,
      idempotency_key: draft.idempotencyKey,
      kind: draft.kind,
      source: draft.source,
      payload: draft.payload,
    });
    const { requestHash } = encodeEnvelope(envelope);
    const prior = findPeerDelivery(tx, envelope);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new Error("peer_idempotency_conflict");
      }
      return prior;
    }
    if (!this.writableTarget(ctx, envelope.target_host_id)) {
      throw new Error("peer_write_unavailable");
    }
    const evaluation = this.contracts.get(envelope.kind)?.(tx, {
      envelope, host: ctx, sourceHostId: ctx.hostId, direction: "outbound",
    });
    if (evaluation?.state !== "ready") {
      throw new Error(evaluation ? "peer_behavior_rejected" : "peer_behavior_unsupported");
    }

    const id = uuidv7(ctx.clock);
    const jobId = enqueueJob(tx, ctx.clock, {
      queue: PEER_DELIVERY_QUEUE,
      payload: { deliveryId: id },
      maxAttempts: deliveryAttempts,
    });
    return insertPeerDelivery(tx, {
      id,
      householdId: envelope.household_id,
      targetHostId: envelope.target_host_id,
      idempotencyKey: envelope.idempotency_key,
      requestHash,
      envelope,
      jobId,
      createdAt: ctx.clock.wallMs(),
    });
  }

  async receive(ctx: HostContext, request: Request, actor: PeerActor): Promise<Response> {
    let input: unknown;
    try {
      input = await readPeerJson(request, MAX_BEHAVIOR_BYTES);
    } catch (error) {
      return inboxError(error instanceof PeerBodyTooLarge ? "peer_payload_too_large" : "peer_invalid_request");
    }
    const parsed = behaviorEnvelope.safeParse(input);
    if (!parsed.success) {
      return inboxError("peer_invalid_request");
    }
    const envelope = parsed.data;
    if (envelope.inbox_version !== PEER_INBOX_VERSION) {
      return inboxError("peer_inbox_version_unsupported");
    }

    let requestHash: string;
    try {
      ({ requestHash } = encodeEnvelope(envelope));
    } catch {
      return inboxError("peer_invalid_request");
    }

    const result = new ChatEvents(ctx).write((db, append) => db.transaction((tx): ReceiveResult => {
      const current = this.transport()?.writablePeer(actor.hostId);
      if (!current || current.hostId !== actor.hostId || actor.access !== "read_write"
        || current.fingerprint !== actor.fingerprint
        || current.protocolVersion !== actor.protocolVersion || current.householdId !== actor.householdId
        || envelope.household_id !== actor.householdId || envelope.household_id !== ctx.householdId
        || envelope.target_host_id !== ctx.hostId || actor.hostId === ctx.hostId) {
        return { error: "peer_target_or_actor_invalid" };
      }

      const prior = getPeerAdmission(tx, envelope, actor.hostId);
      if (prior) {
        return prior.requestHash === requestHash
          ? { receipt: prior.receipt } : { error: "peer_idempotency_conflict" };
      }

      const contract = this.contracts.get(envelope.kind);
      if (!contract) {
        return { error: "peer_behavior_unsupported" };
      }
      const eligibility = contract(tx, { envelope, host: ctx, sourceHostId: actor.hostId, direction: "inbound" });
      if (eligibility.state !== "ready") {
        const code = {
          waiting: "peer_source_pending",
          stale: "peer_publication_stale",
          source_unavailable: "peer_memory_source_unavailable",
          revision_conflict: "peer_memory_revision_conflict",
          rejected: "peer_behavior_rejected",
          invalid: "peer_invalid_request",
        } as const;
        return { error: code[eligibility.state] };
      }

      const admission = eligibility.admit(tx, ctx.clock, append);
      const receipt: PeerReceipt = {
        inbox_version: PEER_INBOX_VERSION,
        receipt_id: uuidv7(ctx.clock),
        admission_id: peerHostId.parse(admission.id),
        household_id: envelope.household_id,
        source_host_id: actor.hostId,
        target_host_id: ctx.hostId,
        idempotency_key: envelope.idempotency_key,
        request_hash: requestHash,
        accepted_at: ctx.clock.wallMs(),
        ...(admission.memoryWrite && { memory_write: admission.memoryWrite }),
      };
      insertPeerAdmission(tx, receipt);
      return { receipt, wakeQueues: admission.wakeQueues };
    }));

    if ("error" in result) {
      return inboxError(result.error);
    }
    for (const queue of result.wakeQueues ?? []) {
      ctx.bus.publish("jobs:wake", { queue });
    }
    return Response.json(result.receipt);
  }

  canStage(ctx: HostContext, targetHostId: string): boolean {
    return this.writableTarget(ctx, targetHostId) !== undefined;
  }

  private writableTarget(ctx: HostContext, targetHostId: string) {
    const transport = this.transport();
    const peer = transport?.writablePeer(targetHostId);
    if (targetHostId !== ctx.hostId
      && peer?.hostId === targetHostId && peer.householdId === ctx.householdId
      && peer.access === "read_write") {
      return transport;
    }
  }

  private async deliver(ctx: JobContext, deliveryId: string): Promise<void> {
    const delivery = getPeerDelivery(ctx.store.db, deliveryId);
    if (!delivery || delivery.jobId !== ctx.job.id || delivery.status !== "pending") {
      throw new Error("Peer 投递与作业状态不一致");
    }
    const { envelope } = delivery;
    const transport = this.writableTarget(ctx, envelope.target_host_id);
    if (!transport || envelope.household_id !== ctx.householdId || envelope.inbox_version !== PEER_INBOX_VERSION) {
      throw new Error("peer_write_unavailable");
    }
    const { body, requestHash } = encodeEnvelope(envelope);
    if (requestHash !== delivery.requestHash) {
      throw new Error("Peer 投递摘要不符");
    }

    const response = await transport.request(envelope.target_host_id, "inbox", {
      headers: { "content-type": "application/json" },
      body,
      signal: ctx.signal,
    });
    const reply = await readPeerJson(response, MAX_RECEIPT_BYTES).catch(() => null);
    ctx.signal.throwIfAborted();
    if (!response.ok) {
      const rejection = inboxRejection(response.status, reply);
      if (rejection) {
        settlePeerDelivery(ctx.store, ctx.clock, ctx.job, deliveryId, { rejection });
        return;
      }
      const error = replyError.safeParse(reply);
      throw new Error(`Peer Inbox HTTP ${response.status}${error.success ? ` ${error.data.error.code}` : ""}`);
    }
    const receipt = peerReceipt.safeParse(reply);
    if (response.status !== 200 || !receipt.success
      || !matchesPeerReceipt(receipt.data, envelope, ctx.hostId, requestHash)) {
      throw new Error("peer_receipt_invalid");
    }
    const confirm = this.confirmations.get(envelope.kind);
    settlePeerDelivery(ctx.store, ctx.clock, ctx.job, deliveryId, {
      receipt: receipt.data,
      confirm: confirm && ((tx) => confirm(tx, ctx.clock, delivery, receipt.data)),
    });
  }
}
