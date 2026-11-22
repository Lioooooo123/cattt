import { z } from "zod";
import { MEMORY_EXTRACTION_QUEUE } from "../store/memory-extraction.ts";
import { ChatEvents } from "../chat-events/index.ts";
import type { GroupSendReceipt, PendingGroupSend } from "../conversations/types.ts";
import type { Actor } from "../identity/index.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import { PEER_DELIVERY_QUEUE } from "../peer-behavior/index.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import {
  ConversationNotFoundError, findMemberMessage, getConversation, IdempotencyConflictError,
  memberMessageResponse, NotPublisherError, publishMemberMessage, sendMessage,
} from "../store/conversations.ts";
import type { GroupReplyPolicy, MemberMessageInput } from "../store/conversations.ts";
import {
  findGroupSend, getGroupSend, groupSenderState, insertGroupSend, pendingGroupSends, updateGroupSend,
} from "../store/group-sends.ts";
import type { GroupSendIntent } from "../store/group-sends.ts";
import { isCurrentDeviceActor } from "../store/identity.ts";
import type { StoreDb } from "../store/index.ts";
import { getPeerDelivery } from "../store/peer-behavior.ts";
import { publicationProof, readPublicationRoute, requireSharedPublisher } from "../store/publication.ts";
import type { ReplicationTx } from "../store/replication-adapter.ts";
import type { Append } from "../store/turn-writes.ts";

const sourceKind = "group_send_intent";
const fenceSchema = z.strictObject({ epoch: z.int().positive(), grant_id: z.uuid() });
const deliveryKey = (id: string, epoch: number) => `group_speak:${id}:${epoch}`;
const receiptUrl = (row: GroupSendIntent) =>
  `/v2/conversations/${row.conversationId}/message-requests/${row.id}`;

export class GroupSends implements Component {
  readonly name = "group-sends";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly channel: PeerBehaviorChannel, private readonly groupReply?: GroupReplyPolicy) {
    channel.register("group_speak", {
      payload: fenceSchema,
      inspect(db, { envelope, host, sourceHostId, direction, payload }) {
        const { source } = envelope;
        if (source.kind !== sourceKind || envelope.idempotency_key !== deliveryKey(source.id, payload.epoch)) {
          return "rejected";
        }
        const route = readPublicationRoute(db, envelope.household_id, host.publication);
        if (!route.current || route.current.epoch < payload.epoch) return "waiting";
        if (route.current.epoch !== payload.epoch || route.current.grantId !== payload.grant_id
          || route.current.holderHostId !== envelope.target_host_id) {
          return "stale";
        }
        if (direction === "inbound" && route.status !== "ready") return "waiting";

        const row = getGroupSend(db, source.id);
        if (!row) return "waiting";
        if (row.originHostId !== sourceHostId || row.householdId !== envelope.household_id
          || row.rev !== source.rev || row.deletedAt !== null) {
          return "rejected";
        }
        // A sealed generation's history contains accepted messages even when the
        // original Inbox receipt never made it back to the sender.
        if (findMemberMessage(db, row)) return "stale";
        return groupSenderState(db, row);
      },
      admit: (tx, clock, { envelope, host, payload }, append) => {
        const row = getGroupSend(tx, envelope.source.id)!;
        const proof = requireSharedPublisher(tx, row.householdId, host.publication, {
          epoch: payload.epoch, grantId: payload.grant_id,
        });
        const { message } = publishMemberMessage(tx, clock, host.hostId, row.householdId,
          memberMessage(row), append, proof, this.groupReply, host.config);
        return { id: message.id, wakeQueues: [MEMORY_EXTRACTION_QUEUE] };
      },
    });
  }

  start(ctx: HostContext): void {
    this.timer = setInterval(() => {
      try {
        for (const row of pendingGroupSends(ctx.store.db, ctx.hostId, ctx.householdId)) {
          const staged = new ChatEvents(ctx).write((db, append) =>
            db.transaction((tx) => this.advance(ctx, tx, row, append)));
          if (staged) this.wakeDelivery(ctx);
        }
      } catch (error) {
        try {
          Promise.resolve(ctx.config.onError
            ? ctx.config.onError(error, this.name) : console.error("群聊发送恢复失败", error)).catch(() => {});
        } catch {}
      }
    }, 250);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  send(ctx: HostContext, actor: Actor, conversationId: string, content: Pick<MemberMessageInput, "clientMessageId" | "text">) {
    const result = new ChatEvents(ctx).write((db, append) => db.transaction((tx) => {
      const conversation = getConversation(tx, actor, conversationId);
      if (conversation.kind === "direct" || ctx.config.groupPublicationAuthority) {
        const sent = sendMessage(tx, ctx.clock, actor, conversationId, content, append, ctx.publication, this.groupReply, ctx.config);
        return { status: sent.created ? 201 as const : 200 as const, body: sent.body };
      }
      const input = { conversationId, memberId: actor.memberId, ...content };
      this.requireLocalSender(ctx, tx, actor, conversationId);
      let row = findGroupSend(tx, input);
      if (row && row.text !== input.text) throw new IdempotencyConflictError();

      if (!row) {
        const message = findMemberMessage(tx, input);
        if (message) {
          if (message.text !== input.text) throw new IdempotencyConflictError();
          if (message.deletedAt !== null) throw new ConversationNotFoundError();
          return { status: 200 as const, body: memberMessageResponse(tx, message) };
        }
        const route = readPublicationRoute(tx, actor.householdId, ctx.publication);
        if (route.status === "ready") {
          const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication);
          return { status: 201 as const, body: publishMemberMessage(tx, ctx.clock, ctx.hostId,
            actor.householdId, input, append, proof, this.groupReply, ctx.config) };
        }
        row = insertGroupSend(tx, ctx.clock, ctx.hostId, actor.householdId, input);
      }

      const staged = this.advance(ctx, tx, row, append);
      const receipt = this.receipt(ctx, tx, getGroupSend(tx, row.id)!);
      if (receipt.body.status === "accepted") {
        const { message, turn } = receipt.body;
        return { status: 200 as const, body: { message, turn }, staged };
      }
      return { ...receipt, staged };
    }));
    if ("staged" in result && result.staged) this.wakeDelivery(ctx);
    if (result.status === 201) {
      ctx.bus.publish("jobs:wake", { queue: MEMORY_EXTRACTION_QUEUE });
      ctx.bus.publish("inference:wake", { sourceMessageId: result.body.message.id });
    }
    return result;
  }

  read(ctx: HostContext, actor: Actor, conversationId: string, requestId: string) {
    return ctx.store.db.transaction((tx) => {
      getConversation(tx, actor, conversationId);
      const row = getGroupSend(tx, requestId);
      if (!row || row.conversationId !== conversationId || row.memberId !== actor.memberId
        || row.originHostId !== ctx.hostId || row.householdId !== actor.householdId) {
        throw new ConversationNotFoundError();
      }
      this.requireLocalSender(ctx, tx, actor, conversationId);
      return this.receipt(ctx, tx, row);
    });
  }

  private requireLocalSender(ctx: HostContext, db: Pick<StoreDb, "select">, actor: Actor, conversationId: string) {
    if (!isCurrentDeviceActor(db, actor)) throw new ConversationNotFoundError();
    if (actor.hostId !== ctx.hostId || actor.householdId !== ctx.householdId
      || groupSenderState(db, { ...actor, conversationId, originHostId: ctx.hostId }) !== "ready") {
      throw new NotPublisherError();
    }
  }

  private wakeDelivery(ctx: HostContext): void {
    ctx.bus.publish("jobs:wake", { queue: PEER_DELIVERY_QUEUE });
  }

  private receipt(ctx: HostContext, db: Pick<StoreDb, "select">, row: GroupSendIntent):
    { status: 200; body: GroupSendReceipt } | { status: 202; body: PendingGroupSend } {
    const request_id = row.id;
    const client_message_id = row.clientMessageId;
    const message = findMemberMessage(db, row);
    const delivery = row.deliveryId ? getPeerDelivery(db, row.deliveryId) : undefined;
    if (message && message.text === row.text && message.deletedAt === null
      && (!delivery?.receipt || delivery.receipt.admission_id === message.id)
      && publicationProof(db, row.householdId, message.publicationEpoch ?? 1)?.holderHostId === message.originHostId) {
      return { status: 200, body: {
        status: "accepted", request_id, client_message_id, publisher_host_id: message.originHostId,
        ...memberMessageResponse(db, message),
      } };
    }
    if (row.status === "rejected" || (message && (message.deletedAt !== null || message.text !== row.text))) {
      return { status: 200, body: {
        status: "rejected", request_id, client_message_id, error: { code: "group_send_rejected" },
      } };
    }
    const route = readPublicationRoute(db, row.householdId, ctx.publication);
    const reason = delivery?.receipt || message ? "replication_pending"
      : route.status === "remote" ? "peer_pending" : "publication_pending";
    return { status: 202, body: {
      status: "pending", request_id, client_message_id, reason, receipt_url: receiptUrl(row),
    } };
  }

  // Only local requests are resumed. Applying a replica never creates work.
  private advance(ctx: HostContext, tx: ReplicationTx, row: GroupSendIntent, append: Append): boolean {
    if (row.status !== "pending" || row.originHostId !== ctx.hostId) return false;
    const message = findMemberMessage(tx, row);
    const sender = groupSenderState(tx, row);
    if (message || sender === "rejected") {
      updateGroupSend(tx, row.id, { status: message ? "accepted" : "rejected" });
      return false;
    }
    const delivery = row.deliveryId ? getPeerDelivery(tx, row.deliveryId) : undefined;
    if (sender !== "ready" || delivery?.receipt) return false;

    const route = readPublicationRoute(tx, row.householdId, ctx.publication);
    if (route.status === "ready") {
      // A later local holder cannot become ready until the previous holder's
      // sealed history is present. An absent message is now safe to admit.
      const proof = requireSharedPublisher(tx, row.householdId, ctx.publication);
      publishMemberMessage(tx, ctx.clock, ctx.hostId, row.householdId, memberMessage(row), append, proof, this.groupReply, ctx.config);
      updateGroupSend(tx, row.id, { status: "accepted" });
      return false;
    }
    const holder = route.current;
    if (route.status !== "remote" || !holder) return false;

    const key = deliveryKey(row.id, holder.epoch);
    if (delivery?.idempotencyKey === key) {
      if (delivery.status === "rejected" && delivery.rejectionCode !== "peer_publication_stale") {
        updateGroupSend(tx, row.id, { status: "rejected" });
      }
      return false;
    }
    if (!this.channel.canStage(ctx, holder.holderHostId)) return false;
    const staged = this.channel.stage(ctx, tx, {
      kind: "group_speak", targetHostId: holder.holderHostId, idempotencyKey: key,
      source: { kind: sourceKind, id: row.id, rev: row.rev },
      payload: { epoch: holder.epoch, grant_id: holder.grantId },
    });
    updateGroupSend(tx, row.id, { deliveryId: staged.id });
    return true;
  }
}

function memberMessage({ conversationId, memberId, clientMessageId, text }: GroupSendIntent): MemberMessageInput {
  return { conversationId, memberId, clientMessageId, text };
}
