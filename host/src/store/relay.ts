import { and, asc, count, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { assessKnowledgeUse } from "../context/policy.ts";
import type { Actor } from "../identity/index.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import { forbidsRelay, readRelayIntent } from "../relay/intent.ts";
import type { ReplicationCursor } from "../replication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { availableAt, localISO } from "../tickets/time.ts";
import { businessRow } from "./business.ts";
import { activeConversation } from "./conversation-publication.ts";
import { appendCatMessage, readConversationScope } from "./conversations.ts";
import { getHouseholdMember, listMembers } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { readKnowledgeSource } from "./knowledge-source.ts";
import { findPeerDelivery, getPeerAdmission } from "./peer-behavior.ts";
import { publicationEpoch } from "./publication-authority.ts";
import { readProactivePermission } from "./proactive-permission.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { appendNativeChange, getPeerCursor, getReplicationHead, nativeMessageExists } from "./replication.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { relayGrants, relayPublications } from "./schema/relay.ts";

type Reader = Pick<StoreDb, "select">;
type Grant = typeof relayGrants.$inferSelect;
type Publication = typeof relayPublications.$inferSelect;
type Mandate = Pick<Grant, "householdId" | "originHostId" | "sourceMemberId" | "sourceMessageId"
  | "sourceRevision" | "targetMemberId" | "targetHostId">;

type ErrorCode = "relay_source_not_found" | "relay_target_unavailable" | "relay_not_allowed"
  | "relay_daily_limit" | "relay_peer_unavailable";

export class RelayError extends Error {
  constructor(readonly code: ErrorCode, readonly status: 404 | 409) {
    super(code);
  }
}

export const relayKey = (sourceMessageId: string) => `relay:${sourceMessageId}`;

export function readRelayGrant(db: Reader, id: string) {
  return db.select().from(relayGrants).where(eq(relayGrants.id, id)).get();
}

function relayPublication(db: Reader, id: string) {
  return db.select().from(relayPublications).where(eq(relayPublications.grantId, id)).get();
}

export function admitRelayPublication(tx: ReplicationTx, clock: Clock, grantId: string, targetHostId: string) {
  tx.insert(relayPublications).values({
    grantId, targetHostId, state: "pending", retryAt: clock.wallMs(),
  }).onConflictDoNothing().run();
  return { id: grantId };
}

function laterVeto(db: Reader, source: NonNullable<ReturnType<typeof readKnowledgeSource>>) {
  return db.select({ text: messages.text }).from(messages).where(and(
    eq(messages.conversationId, source.conversationId),
    eq(messages.authorMemberId, source.authorMemberId!),
    isNull(messages.deletedAt),
    or(gt(messages.hlc, source.hlc), and(eq(messages.hlc, source.hlc), gt(messages.id, source.id))),
  )).all().some(({ text }) => forbidsRelay(text));
}

type RelayReview = { reason: string } | { text: string; urgent: boolean };

export function reviewRelayMandate(db: Reader, mandate: Mandate): RelayReview {
  const { householdId, sourceMemberId, sourceMessageId, sourceRevision, originHostId, targetMemberId, targetHostId } = mandate;
  const source = readKnowledgeSource(db, mandate);
  const author = getHouseholdMember(db, householdId, sourceMemberId);
  const recipient = getHouseholdMember(db, householdId, targetMemberId);
  const scope = source && readConversationScope(db, source.conversationId);
  if (!source || source.originHostId !== originHostId || author?.homeHostId !== originHostId
    || !scope?.participantMemberIds.includes(sourceMemberId)) {
    return { reason: "source_unavailable" } as const;
  }
  if (targetMemberId === sourceMemberId || recipient?.homeHostId !== targetHostId) {
    return { reason: "target_unavailable" } as const;
  }
  const intent = readRelayIntent(source.text);
  if (!intent || laterVeto(db, source)) {
    return { reason: "relay_not_allowed" } as const;
  }
  const text = `${author.displayName}托我转告你：${intent.content}`;
  const policy = assessKnowledgeUse(db, {
    householdId, audienceMemberIds: [sourceMemberId, targetMemberId],
    evidence: [{ kind: "message", sourceMemberId, sourceMessageId, sourceRevision }], text,
  });
  if (policy !== "allowed") {
    return { reason: policy };
  }
  return { text, urgent: intent.urgent };
}

function dto(db: Reader, grant: Grant) {
  const base = { id: grant.id, source_day: grant.sourceDay, source_time_zone: grant.sourceTimeZone, urgent: grant.urgent };
  if (grant.targetHostId === grant.originHostId) {
    const publication = relayPublication(db, grant.id)!;
    return { ...base, state: publication.state, peer_receipt: null, published_message_id: publication.messageId, reason: publication.reason };
  }
  const delivery = findPeerDelivery(db, {
    household_id: grant.householdId, target_host_id: grant.targetHostId, idempotency_key: relayKey(grant.sourceMessageId),
  });
  return {
    ...base, state: delivery?.receipt ? "accepted" : delivery?.status === "rejected" ? "rejected" : "queued",
    peer_receipt: delivery?.receipt ?? null, published_message_id: null, reason: null,
  };
}

export function requestRelay(
  ctx: HostContext, peer: PeerBehaviorChannel, actor: Actor, input: { sourceMessageId: string; sourceRevision: number },
) {
  return ctx.store.db.transaction((tx) => {
    const householdId = actor.householdId;
    if (actor.hostId !== ctx.hostId || ctx.householdId !== householdId
      || getHouseholdMember(tx, householdId, actor.memberId)?.homeHostId !== ctx.hostId) {
      throw new RelayError("relay_source_not_found", 404);
    }
    const prior = tx.select().from(relayGrants).where(eq(relayGrants.sourceMessageId, input.sourceMessageId)).get();
    if (prior?.sourceMemberId === actor.memberId && prior.sourceRevision === input.sourceRevision
      && prior.originHostId === ctx.hostId && prior.householdId === householdId) {
      return dto(tx, prior);
    }
    const proof = { householdId, sourceMemberId: actor.memberId, ...input };
    const original = readKnowledgeSource(tx, proof);
    if (!original || original.originHostId !== ctx.hostId || prior) {
      throw new RelayError("relay_source_not_found", 404);
    }
    const head = getReplicationHead(tx, ctx.hostId);
    if (!nativeMessageExists(tx, head, original.id, original.rev)) {
      throw new RelayError("relay_not_allowed", 409);
    }
    const partners = listMembers(tx, householdId).filter(({ id }) => id !== actor.memberId);
    const partner = partners[0];
    if (partners.length !== 1 || !partner) {
      throw new RelayError("relay_target_unavailable", 409);
    }
    const mandate: Mandate = {
      ...proof, originHostId: ctx.hostId, targetMemberId: partner.id, targetHostId: partner.homeHostId,
    };
    const reviewed = reviewRelayMandate(tx, mandate);
    if ("reason" in reviewed) {
      throw new RelayError("relay_not_allowed", 409);
    }
    const timeZone = readProactivePermission(tx, actor.memberId).timeZone;
    const business = businessRow(ctx.clock, ctx.hostId);
    const day = localISO(business.createdAt, timeZone).slice(0, 10);
    if (!reviewed.urgent) {
      const { used } = tx.select({ used: count() }).from(relayGrants).where(and(
        eq(relayGrants.sourceMemberId, actor.memberId), eq(relayGrants.sourceDay, day), eq(relayGrants.urgent, false),
      )).get()!;
      if (used >= 3) {
        throw new RelayError("relay_daily_limit", 409);
      }
    }
    const grant = tx.insert(relayGrants).values({
      ...business, ...mandate, urgent: reviewed.urgent, sourceDay: day, sourceTimeZone: timeZone,
      sourceGeneration: head.generation, sourceSeq: head.seq + 1,
    }).returning().get()!;
    appendNativeChange(tx, ctx.hostId, householdId, replicaAdapters.relay_grant, grant);
    if (grant.targetHostId === ctx.hostId) {
      admitRelayPublication(tx, ctx.clock, grant.id, ctx.hostId);
    } else {
      try {
        peer.stage(ctx, tx, {
          targetHostId: grant.targetHostId, idempotencyKey: relayKey(grant.sourceMessageId), kind: "relay",
          source: { kind: "message", id: grant.sourceMessageId, rev: grant.sourceRevision },
          payload: { grant_id: grant.id, source_generation: grant.sourceGeneration, source_seq: grant.sourceSeq },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "peer_write_unavailable") {
          throw new RelayError("relay_peer_unavailable", 409);
        }
        throw error;
      }
    }
    return dto(tx, grant);
  }, { behavior: "immediate" });
}

export function readRelayCursor(db: Reader, localHostId: string, sourceHostId: string) {
  return sourceHostId === localHostId ? getReplicationHead(db, localHostId) : getPeerCursor(db, sourceHostId);
}

export function relayDue(ctx: HostContext) {
  return ctx.store.db.select({ id: relayPublications.grantId }).from(relayPublications).where(and(
    eq(relayPublications.targetHostId, ctx.hostId), eq(relayPublications.state, "pending"),
    lte(relayPublications.retryAt, ctx.clock.wallMs()),
  )).orderBy(asc(relayPublications.retryAt), asc(relayPublications.grantId)).limit(100).all();
}

export type RemoteRelayProof = {
  cursor: ReplicationCursor;
  isStillPaired(): boolean;
};

export function publishRelay(ctx: HostContext, id: string, verified?: RemoteRelayProof | null) {
  return ctx.store.db.transaction((tx) => {
    const publication = relayPublication(tx, id);
    const now = ctx.clock.wallMs();
    if (!publication || publication.state !== "pending" || publication.targetHostId !== ctx.hostId
      || publication.retryAt! > now) {
      return;
    }
    const update = (values: Partial<Publication>) => tx.update(relayPublications)
      .set(values).where(eq(relayPublications.grantId, id)).run();
    const drop = (reason: string) => { update({ state: "dropped", reason, retryAt: null }); };
    const defer = (reason: string, retryAt: number) => { update({ reason, retryAt }); };
    const grant = readRelayGrant(tx, id)!;
    const remote = grant.originHostId !== ctx.hostId;
    const cursor = readRelayCursor(tx, ctx.hostId, grant.originHostId);
    if (!cursor) {
      return defer("source_sync_pending", now + 1_000);
    }
    if (cursor.generation !== grant.sourceGeneration || grant.householdId !== ctx.householdId
      || grant.targetHostId !== ctx.hostId) {
      return drop("source_generation_changed");
    }
    if (cursor.seq < grant.sourceSeq) {
      return defer("source_sync_pending", now + 1_000);
    }
    if (remote) {
      const receipt = getPeerAdmission(tx, {
        household_id: grant.householdId, idempotency_key: relayKey(grant.sourceMessageId),
      }, grant.originHostId)?.receipt;
      if (receipt?.admission_id !== grant.id || receipt.target_host_id !== ctx.hostId) {
        return drop("peer_receipt_invalid");
      }
    }
    const reviewed = reviewRelayMandate(tx, grant);
    if ("reason" in reviewed || reviewed.urgent !== grant.urgent) {
      return drop("reason" in reviewed ? reviewed.reason : "relay_not_allowed");
    }
    const conversation = tx.select().from(conversations).where(and(
      eq(conversations.householdId, grant.householdId), eq(conversations.kind, "direct"),
      eq(conversations.ownerMemberId, grant.targetMemberId), isNull(conversations.deletedAt),
    )).get();
    if (!conversation || conversation.publisherHostId !== ctx.hostId
      || !readConversationScope(tx, conversation.id)?.participantMemberIds.includes(grant.targetMemberId)
      || publicationEpoch(tx, ctx.clock, conversation) !== "direct") {
      return drop("target_unavailable");
    }
    const allowedAt = availableAt(now, readProactivePermission(tx, grant.targetMemberId).timeZone);
    if (allowedAt > now) {
      return defer("quiet_hours", allowedAt);
    }
    if (activeConversation(tx, conversation.id)) {
      return defer("conversation_busy", now + 1_000);
    }
    if (remote) {
      if (verified === undefined) {
        return { cursor };
      }
      if (!verified || verified.cursor.sourceHostId !== grant.originHostId
        || verified.cursor.generation !== grant.sourceGeneration || cursor.seq < verified.cursor.seq
        || verified.cursor.seq < grant.sourceSeq || !verified.isStillPaired()) {
        return defer("source_sync_pending", now + 1_000);
      }
    }
    const message = appendCatMessage(tx, ctx.clock, {
      hostId: ctx.hostId, conversationId: conversation.id, text: reviewed.text,
      status: "complete", replyToMessageId: null, turnId: null,
      knowledgeEvidence: [{
        kind: "message", sourceMemberId: grant.sourceMemberId, sourceMessageId: grant.sourceMessageId,
        sourceRevision: grant.sourceRevision,
      }],
    });
    update({ state: "published", reason: null, retryAt: null, messageId: message.id });
  }, { behavior: "immediate" });
}
