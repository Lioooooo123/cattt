import { z } from "zod";
import type { Actor } from "../identity/index.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import { peerHostId } from "../peer/protocol.ts";
import { businessFields, replicationSourceSchema } from "../replication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { getHouseholdMember } from "../store/identity.ts";
import type { StoreDb } from "../store/index.ts";
import { getJob } from "../store/jobs.ts";
import {
  canManageMemory, confirmPeerMemoryBlock, getMemoryRecord, isSupersededMemory, listAvailableMemories,
  reviseMemory, withdrawMemory,
} from "../store/knowledge.ts";
import type { Memory } from "../store/knowledge.ts";
import { readKnowledgeSource } from "../store/knowledge-source.ts";
import { MemberResourceError } from "../store/member-resources.ts";
import type { MemberResourceDb } from "../store/member-resources.ts";
import type { PeerDelivery } from "../store/peer-behavior.ts";
import { getPeerCursor, getReplicationHead } from "../store/replication.ts";

const kind = "memory_action";
const sourceKind = "memory";
const proof = {
  actor_member_id: peerHostId,
  request_id: z.uuid(),
  source_member_id: peerHostId,
  source_message_id: peerHostId,
  source_revision: z.int().positive(),
  memory_hlc: businessFields.hlc,
  writer_generation: replicationSourceSchema.shape.generation,
};
const payloadSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...proof, operation: z.literal("memory.revise"), value: z.string().trim().min(1).max(2000) }),
  z.strictObject({ ...proof, operation: z.literal("memory.forget") }),
]);
type MemoryActionPayload = z.infer<typeof payloadSchema>;
type Reader = Pick<StoreDb, "select">;

const deliveryKey = (memberId: string, requestId: string) => `${kind}:${memberId}:${requestId}`;

function matchesSource(row: Memory, payload: MemoryActionPayload): boolean {
  return row.sourceMemberId === payload.source_member_id
    && row.sourceMessageId === payload.source_message_id && row.sourceRevision === payload.source_revision;
}

export function registerMemoryActions(channel: PeerBehaviorChannel) {
  channel.register(kind, {
    payload: payloadSchema,
    inspect(db, { envelope, host, sourceHostId, direction, payload }) {
      const { source, household_id: householdId, target_host_id: writerHostId } = envelope;
      const actor = { householdId, memberId: payload.actor_member_id };
      if (source.kind !== sourceKind || source.rev >= Number.MAX_SAFE_INTEGER
        || envelope.idempotency_key !== deliveryKey(actor.memberId, payload.request_id)
        || getHouseholdMember(db, householdId, actor.memberId)?.homeHostId !== sourceHostId) {
        return "rejected";
      }
      const generation = direction === "inbound"
        ? getReplicationHead(db, host.hostId).generation : getPeerCursor(db, writerHostId)?.generation;
      if (generation !== payload.writer_generation) return "revision_conflict";
      const row = getMemoryRecord(db, { householdId, id: source.id });
      if (!row) return "revision_conflict";
      if (row.originHostId !== writerHostId || !canManageMemory(actor, row) || !matchesSource(row, payload)) {
        return "rejected";
      }
      if (row.deletedAt !== null || row.rev !== source.rev || row.hlc !== payload.memory_hlc) {
        return "revision_conflict";
      }
      const original = readKnowledgeSource(db, row);
      if (!original || original.originHostId !== row.originHostId) {
        return "source_unavailable";
      }
      if (!listAvailableMemories(db, { householdId, id: row.id })[0]) {
        return isSupersededMemory(db, row.id) ? "revision_conflict" : "source_unavailable";
      }
      return "ready";
    },
    admit(tx, clock, { envelope, payload }) {
      const actor = { householdId: envelope.household_id, memberId: payload.actor_member_id };
      const { id, rev } = envelope.source;
      const memory = payload.operation === "memory.revise"
        ? reviseMemory(tx, clock, actor, id, rev, payload.value)
        : withdrawMemory(tx, clock, actor, id, rev);
      if (!memory) throw new Error("记忆变更未写入，回滚 peer 收据");
      return { id: memory.id, memoryWrite: { revision: memory.rev, hlc: memory.hlc } };
    },
    confirm(tx, clock, delivery, payload, receipt) {
      const { source } = delivery.envelope;
      if (receipt.admission_id !== source.id || receipt.memory_write?.revision !== source.rev + 1) {
        throw new Error("peer_memory_receipt_invalid");
      }
      if (payload.operation !== "memory.forget") return;
      const householdId = delivery.householdId;
      const member = getHouseholdMember(tx, householdId, payload.actor_member_id);
      if (!member) return; // 该主体已移除，保留原创撤回的回执即可。
      const row = getMemoryRecord(tx, { householdId, id: source.id });
      if (!row || row.originHostId !== delivery.targetHostId || !matchesSource(row, payload)
        || !canManageMemory({ householdId, memberId: member.id }, row) || !confirmPeerMemoryBlock(tx, clock, row)) {
        throw new Error("peer_memory_block_pending");
      }
    },
  });
}

export function stageMemoryAction(
  ctx: HostContext, tx: MemberResourceDb, channel: PeerBehaviorChannel | undefined,
  actor: Actor, row: Memory, requestId: string, value: string | undefined,
): string {
  const writer = row.originHostId;
  const cursor = getPeerCursor(tx, writer);
  if (!cursor || !channel?.canStage(ctx, writer)) {
    throw new MemberResourceError("peer_write_unavailable", writer);
  }
  if (readKnowledgeSource(tx, row)?.originHostId !== writer) {
    throw new MemberResourceError("source_unavailable");
  }
  const payload: MemoryActionPayload = {
    actor_member_id: actor.memberId,
    request_id: requestId,
    source_member_id: row.sourceMemberId,
    source_message_id: row.sourceMessageId,
    source_revision: row.sourceRevision,
    memory_hlc: row.hlc,
    writer_generation: cursor.generation,
    ...(value === undefined ? { operation: "memory.forget" } : { operation: "memory.revise", value }),
  };
  return channel.stage(ctx, tx, {
    targetHostId: writer,
    kind,
    idempotencyKey: deliveryKey(actor.memberId, requestId),
    source: { kind: sourceKind, id: row.id, rev: row.rev },
    payload,
  }).id;
}

export function projectMemoryAction(
  db: Reader, actor: Actor, delivery: PeerDelivery, memoryId: string, requestId: string,
) {
  const { envelope } = delivery;
  if (delivery.householdId !== actor.householdId || envelope.kind !== kind || envelope.source.id !== memoryId
    || delivery.idempotencyKey !== deliveryKey(actor.memberId, requestId)) {
    throw new MemberResourceError("not_found");
  }
  const identity = {
    request_id: requestId,
    memory_id: memoryId,
    writer_host_id: delivery.targetHostId,
    receipt_url: `/v2/memories/${memoryId}/requests/${requestId}`,
  };
  if (delivery.status === "rejected") {
    const code = delivery.rejectionCode;
    const error_code = code === "peer_memory_revision_conflict" ? "revision_conflict"
      : code === "peer_memory_source_unavailable" ? "source_unavailable"
      : code === "peer_behavior_rejected" ? "not_found" : "peer_write_unavailable";
    return { ...identity, status: "rejected" as const, error_code };
  }
  if (delivery.status === "pending") {
    const error = getJob(db, delivery.jobId)?.lastError;
    const status = error?.endsWith("peer_memory_block_pending") ? "waiting_for_replication"
      : error ? "waiting_for_peer" : "queued";
    return { ...identity, status };
  }
  const write = delivery.receipt!.memory_write!;
  const row = getMemoryRecord(db, { householdId: actor.householdId, id: memoryId });
  if (row?.originHostId === delivery.targetHostId && (row.rev > write.revision
    || (row.rev === write.revision && row.hlc === write.hlc))) {
    return { ...identity, status: "applied" as const, resulting_revision: write.revision };
  }
  return { ...identity, status: "waiting_for_replication" as const };
}
