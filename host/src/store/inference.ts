import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { assessKnowledgeUse, readKnowledgePolicy } from "../context/policy.ts";
import type { AssessmentDecision, AssessmentInput, InferenceEvidence } from "../inference/assessment.ts";
import { alreadyAnswered, askOutcomeRuleId, dayMs, defaultAskOutcomeRule, outcomeEvent, outcomeLabels } from "../inference/rules.ts";
import type { HostContext } from "../runtime/index.ts";
import type { ConversationHead } from "../ticket-workers/types.ts";
import { availableAt, localISO } from "../tickets/time.ts";
import { businessRow } from "./business.ts";
import { activeConversation, conversationHead, freshConversation, writePublicationDelivery } from "./conversation-publication.ts";
import { readConversationScope } from "./conversations.ts";
import type { StoreDb } from "./index.ts";
import { listModelVisibleMessages } from "./model-visible-messages.ts";
import { readProactivePermission } from "./proactive-permission.ts";
import { appendNativeChange } from "./replication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { publicationProof } from "./publication.ts";
import { ticketPublications } from "./schema/publications.ts";
import { publicationEpoch } from "./publication-authority.ts";
import { messages } from "./schema/conversations.ts";
import { inferenceCandidates, inferenceDailyReceipts } from "./schema/inference.ts";
import { tickets } from "./schema/tickets.ts";

type Reader = Pick<StoreDb, "select">;
type Candidate = typeof inferenceCandidates.$inferSelect;
type Snapshot = {
  assessment: AssessmentInput;
  head: ConversationHead;
};
type Ready = {
  snapshot: Snapshot;
  deliveryBudget: { memberId: string; localDay: string; sourceMessageId: string }[];
  text: string;
};
type Gate = Ready | { drop: string } | { defer: number; reason: string };

export function getInferenceCandidate(db: Reader, id: string): Candidate | undefined {
  return db.select().from(inferenceCandidates).where(eq(inferenceCandidates.sourceMessageId, id)).get();
}

export function dueInference(ctx: HostContext): string[] {
  return ctx.store.db.select({ id: inferenceCandidates.sourceMessageId }).from(inferenceCandidates).where(and(
    eq(inferenceCandidates.hostId, ctx.hostId), eq(inferenceCandidates.status, "pending"),
    lte(inferenceCandidates.retryAt, ctx.clock.wallMs()),
  )).orderBy(asc(inferenceCandidates.retryAt), asc(inferenceCandidates.sourceMessageId)).limit(20).all()
    .map(({ id }) => id);
}

function readGate(ctx: HostContext, db: Reader, candidate: Candidate, previous?: Snapshot): Gate {
  const { clock, config, householdId } = ctx;
  const now = clock.wallMs();
  const expiry = candidate.afterAt + dayMs + 1;
  const rule = config.askOutcomeRule ?? defaultAskOutcomeRule;
  if (rule.mode === "off" || rule.mode !== candidate.rule.mode || rule.version !== candidate.rule.version) {
    return { drop: "rule_changed" };
  }
  if (now >= expiry) { return { drop: "expired" }; }

  const scope = readConversationScope(db, candidate.conversationId);
  if (!scope || scope.householdId !== householdId || scope.householdId !== candidate.householdId
    || !scope.participantMemberIds.includes(candidate.sourceMemberId)
    || (scope.kind === "direct" && scope.ownerMemberId !== candidate.sourceMemberId)) {
    return { drop: "conversation_unavailable" };
  }
  const epoch = publicationEpoch(db, clock, scope, config.groupPublicationAuthority, ctx.publication);
  if (epoch !== candidate.publicationEpoch) { return { drop: "publication_authority_changed" }; }

  const audience = scope.participantMemberIds.map((id) => readProactivePermission(db, id));
  if (audience.length !== candidate.audience.length || audience.some(({ memberId, revision, allowed }, index) =>
    !allowed || candidate.audience[index]!.memberId !== memberId || candidate.audience[index]!.revision !== revision)) {
    return { drop: "permission_changed" };
  }

  const { sourceMessageId, sourceRevision, sourceMemberId } = candidate;
  const proof = { householdId, sourceMessageId, sourceRevision, sourceMemberId };
  const [source] = listModelVisibleMessages(db, householdId, candidate.conversationId, [sourceMessageId]);
  if (!source || source.authorMemberId !== sourceMemberId || source.rev !== sourceRevision
    || source.status !== "complete" || source.originHostId !== candidate.hostId) {
    return { drop: "source_unavailable" };
  }
  const event = outcomeEvent(source.text, source.createdAt, candidate.sourceTimeZone);
  if (!event || event.topic !== candidate.topic || event.afterAt !== candidate.afterAt) {
    return { drop: "source_changed" };
  }
  const text = `${outcomeLabels[event.topic]}后来怎么样？`;
  const sourcePolicy = assessKnowledgeUse(db, {
    householdId, audienceMemberIds: scope.participantMemberIds, text, evidence: [{ kind: "message", ...proof }],
  });
  if (sourcePolicy !== "allowed") { return { drop: sourcePolicy }; }
  if (previous && !freshConversation(db, scope, previous.head)) {
    return { drop: "conversation_changed" };
  }
  if (now < candidate.afterAt) {
    return { defer: candidate.afterAt, reason: "not_due" };
  }

  const later = db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.conversationId, scope.id), eq(messages.authorMemberId, sourceMemberId),
    eq(messages.status, "complete"), isNull(messages.deletedAt),
    or(gt(messages.hlc, source.hlc), and(eq(messages.hlc, source.hlc), gt(messages.id, source.id))),
  )).orderBy(desc(messages.hlc), desc(messages.id)).all();
  const visible = new Map(listModelVisibleMessages(db, householdId, scope.id, later.map(({ id }) => id))
    .map((row) => [row.id, row]));
  const { avoids } = readKnowledgePolicy(db, householdId, scope.participantMemberIds);
  const recent: InferenceEvidence[] = [];
  for (const { id } of later) {
    const row = visible.get(id);
    if (!row || avoids(row.text)) { continue; }
    if (alreadyAnswered(row.text, candidate.topic)) { return { drop: "already_resolved" }; }
    if (recent.length < 6) { recent.push({ id, text: row.text, revision: row.rev, memberId: sourceMemberId }); }
  }
  if (previous && JSON.stringify(previous.assessment.recent) !== JSON.stringify(recent)) {
    return { drop: "conversation_changed" };
  }

  const deliveryBudget = audience.map(({ memberId, timeZone }) => ({
    memberId, localDay: localISO(now, timeZone).slice(0, 10), sourceMessageId,
  }));
  if (rule.mode === "auto") {
    const next = Math.max(...audience.map(({ timeZone }) => availableAt(now, timeZone)));
    if (next > now) { return { defer: Math.min(next, expiry), reason: "quiet_hours" }; }
    if (deliveryBudget.some(({ memberId, localDay }) => db.select({ memberId: inferenceDailyReceipts.memberId })
      .from(inferenceDailyReceipts).where(and(
        eq(inferenceDailyReceipts.memberId, memberId), eq(inferenceDailyReceipts.localDay, localDay),
      )).get() || db.select({ id: ticketPublications.id }).from(ticketPublications).where(and(
        eq(ticketPublications.householdId, householdId), eq(ticketPublications.kind, "inference"),
        sql`EXISTS (SELECT 1 FROM json_each(${ticketPublications.audienceDays}) day
          WHERE json_extract(day.value, '$.memberId') = ${memberId} AND json_extract(day.value, '$.localDay') = ${localDay})`,
      )).limit(1).get())) {
      return { drop: "daily_limit" };
    }
    if (activeConversation(db, scope.id)) {
      return { defer: Math.min(now + 1000, expiry), reason: "conversation_busy" };
    }
  }
  return {
    snapshot: {
      head: conversationHead(db, scope.id),
      assessment: {
        rule: { id: askOutcomeRuleId, version: rule.version },
        source: { id: source.id, memberId: sourceMemberId, revision: source.rev, text: source.text },
        event,
        recent,
      },
    },
    deliveryBudget,
    text,
  };
}

export function prepareInference(ctx: HostContext, id: string): Snapshot | undefined {
  return evaluateCandidate(ctx, id);
}

export function finalizeInference(ctx: HostContext, id: string, previous: Snapshot, decision: AssessmentDecision): void {
  evaluateCandidate(ctx, id, { previous, decision });
}

function evaluateCandidate(
  ctx: HostContext, id: string, evaluated?: { previous: Snapshot; decision: AssessmentDecision },
): Snapshot | undefined {
  return ctx.store.db.transaction((tx) => {
    const now = ctx.clock.wallMs();
    const candidate = getInferenceCandidate(tx, id);
    if (!candidate || candidate.hostId !== ctx.hostId || candidate.status !== "pending" || candidate.retryAt! > now) {
      return;
    }
    const update = (values: Partial<Candidate>) => tx.update(inferenceCandidates)
      .set(values).where(eq(inferenceCandidates.sourceMessageId, id)).run();
    const settle = (status: "observed" | "dropped", reason: string) =>
      update({ status, reason, retryAt: null, resolvedAt: now });
    const gate = readGate(ctx, tx, candidate, evaluated?.previous);
    if ("drop" in gate) {
      settle("dropped", gate.drop);
      return;
    }
    if ("defer" in gate) {
      update({ retryAt: gate.defer, reason: gate.reason });
      return;
    }
    if (!evaluated) {
      return gate.snapshot;
    }
    if (evaluated.decision !== "accept") {
      settle("dropped", `assessment_${evaluated.decision}`);
      return;
    }
    if (candidate.rule.mode === "observe") {
      settle("observed", "would_ask");
      return;
    }
    const { hostId, householdId, conversationId, sourceMemberId, sourceMessageId, sourceRevision } = candidate;
    const scope = readConversationScope(tx, conversationId)!;
    const epoch = scope.kind === "group" ? publicationProof(tx, householdId)!.epoch : null;
    const ticket = tx.insert(tickets).values({
      ...businessRow(ctx.clock, hostId), householdId, conversationId,
      forMemberId: sourceMemberId, publisherHostId: hostId, publicationEpoch: epoch, kind: "followup", mandateKind: "inferred",
      sourceMessageId, sourceRevision, goal: gate.text, status: "ended", stage: "completed",
      endedReason: "delivered", dueAt: candidate.afterAt, timeZone: candidate.sourceTimeZone,
    }).returning().get()!;
    appendNativeChange(tx, hostId, householdId, replicaAdapters.ticket, ticket);
    const delivery = writePublicationDelivery(tx, ctx.clock, {
      hostId, householdId, conversationId, forMemberId: sourceMemberId, ticketId: ticket.id, sourceMessageId,
    }, { chat: gate.text, letter: gate.text }, {
      epoch, ticketRev: ticket.rev, kind: "inference",
      audienceDays: gate.deliveryBudget.map(({ memberId, localDay }) => ({ memberId, localDay })),
    });
    tx.insert(inferenceDailyReceipts).values(gate.deliveryBudget).run();
    update({
      ...delivery, ticketId: ticket.id, status: "published", reason: null, retryAt: null, resolvedAt: now,
    });
    return;
  }, { behavior: "immediate" });
}
