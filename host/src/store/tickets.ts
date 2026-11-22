import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { localISO } from "../tickets/time.ts";
import { TicketError } from "../tickets/types.ts";
import type { SourceProof, TicketAdmissionPolicy, TicketJob, TicketStatusFilter } from "../tickets/types.ts";
import type { GroupPublicationAuthority } from "../router/types.ts";
import type { PublicationWindow } from "../publication/window.ts";
import { currentConversationEpoch } from "./publication-authority.ts";
import { publicationProof } from "./publication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { appendNativeChange } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { revision } from "./business.ts";
import { ConversationNotFoundError, visibleConversation } from "./conversations.ts";
import { getHostMeta } from "./host-meta.ts";
import { getMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { enqueueJob, supersedeJob } from "./jobs.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { households, hosts, members } from "./schema/identity.ts";
import { runs, ticketInputs, tickets } from "./schema/tickets.ts";

type Reader = Pick<StoreDb, "select">;
export type TicketRow = typeof tickets.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export function ticketView(row: TicketRow) {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    for_member_id: row.forMemberId,
    publisher_host_id: row.publisherHostId,
    kind: row.kind,
    mandate_kind: row.mandateKind,
    source_message_id: row.sourceMessageId,
    source_revision: row.sourceRevision,
    goal: row.goal,
    status: row.status,
    stage: row.stage,
    due_at: row.dueAt,
    time_zone: row.timeZone,
    ended_reason: row.endedReason,
  };
}

export function isResumable(ticket: TicketRow): boolean {
  return ticket.kind === "errand" && ticket.mandateKind === "explicit" && ticket.status === "ended"
    && (ticket.stage === "failed" || ticket.stage === "blocked");
}

export function ticketConversation(db: Reader, actor: Actor, conversationId: string) {
  try {
    return visibleConversation(db, actor, conversationId);
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      throw new TicketError(404, "not_found", "没有这件事");
    }
    throw error;
  }
}

function belongsToActor(actor: Actor) {
  return and(eq(tickets.householdId, actor.householdId), eq(tickets.forMemberId, actor.memberId), isNull(tickets.deletedAt));
}

export function readActorTicket(db: Reader, actor: Actor, id: string): TicketRow {
  const ticket = db.select().from(tickets).where(and(belongsToActor(actor), eq(tickets.id, id))).get();
  if (!ticket) {
    throw new TicketError(404, "not_found", "没有这件事");
  }
  ticketConversation(db, actor, ticket.conversationId);
  return ticket;
}

export function listActorTickets(
  db: Pick<StoreDb, "transaction">, actor: Actor, status: TicketStatusFilter = "open", conversationId?: string,
) {
  return db.transaction((tx) => {
    if (conversationId !== undefined) ticketConversation(tx, actor, conversationId);
    return readActorTickets(tx, actor, status, conversationId).map(ticketView);
  });
}

export function readActorTickets(db: Reader, actor: Actor, status: TicketStatusFilter, conversationId?: string) {
  const visible = db.select({ id: conversations.id }).from(conversations)
    .innerJoin(participants, eq(participants.conversationId, conversations.id))
    .where(and(
      eq(conversations.householdId, actor.householdId), isNull(conversations.deletedAt),
      eq(participants.memberId, actor.memberId), isNull(participants.deletedAt),
      or(eq(conversations.kind, "group"), eq(conversations.ownerMemberId, actor.memberId)),
    ));
  const statusFilter = status === "all" ? undefined : status === "actionable"
    ? or(eq(tickets.status, "open"), and(eq(tickets.kind, "errand"), eq(tickets.status, "ended"),
      inArray(tickets.stage, ["failed", "blocked"])))
    : eq(tickets.status, status);
  return db.select().from(tickets).where(and(
    belongsToActor(actor), inArray(tickets.conversationId, visible), statusFilter,
    conversationId === undefined ? undefined : eq(tickets.conversationId, conversationId),
  )).orderBy(asc(tickets.dueAt), asc(tickets.createdAt), asc(tickets.id)).all();
}

function inLiveHousehold(db: Reader, householdId: string, hostId: string) {
  return db.select({ id: hosts.id }).from(hosts)
    .innerJoin(households, eq(hosts.householdId, households.id))
    .where(and(eq(hosts.id, hostId), eq(households.id, householdId),
      isNull(hosts.deletedAt), isNull(households.deletedAt))).get() !== undefined;
}

export function localTicketPublisher(
  db: Reader, householdId: string, publisherHostId: string, expectedTicketHost?: string,
): string {
  const local = getHostMeta(db, "host_id");
  if (!local || local !== publisherHostId || (expectedTicketHost !== undefined && expectedTicketHost !== local)
    || !inLiveHousehold(db, householdId, local)) {
    throw new TicketError(409, "not_publisher", "请连接这件事的发布宿主");
  }
  return local;
}

export function readTicketSource(db: Reader, conversationId: string, proof: SourceProof, policy?: TicketAdmissionPolicy) {
  const source = db.select({ message: messages }).from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(households, eq(households.id, conversations.householdId))
    .innerJoin(members, eq(members.id, messages.authorMemberId))
    .where(and(
      eq(messages.id, proof.sourceMessageId), eq(messages.rev, proof.sourceRevision),
      eq(messages.conversationId, conversationId), eq(members.id, proof.sourceMemberId),
      eq(conversations.householdId, proof.householdId), eq(members.householdId, proof.householdId),
      eq(messages.status, "complete"), isNull(messages.deletedAt), isNull(members.deletedAt),
      isNull(conversations.deletedAt), isNull(households.deletedAt),
    )).get()?.message;
  if (!source
    || (policy?.readKnowledgeSource && policy.readKnowledgeSource(db, proof)?.id !== source.id)) {
    throw new TicketError(409, "source_unavailable", "原话已不可使用");
  }
  return source;
}

export function assertTicketTopic(
  db: Reader, scope: Pick<TicketRow, "householdId" | "forMemberId" | "conversationId">,
  texts: readonly string[], policy?: TicketAdmissionPolicy,
): void {
  if (policy?.allowsTopic && !policy.allowsTopic(db, {
    householdId: scope.householdId, memberId: scope.forMemberId,
    conversationId: scope.conversationId, text: texts.join("\n"),
  })) {
    throw new TicketError(409, "permission_denied", "这件事涉及已设为回避的话题");
  }
}

/** 执行与出版可在各自事务中重复核对原授权与补充。 */
export function assertTicketMandate(
  db: Reader, ticket: TicketRow, policy?: TicketAdmissionPolicy, extra: readonly string[] = [],
): void {
  if (ticket.mandateKind !== "explicit") {
    throw new TicketError(409, "permission_denied", "事项缺少明确授权");
  }
  const proof = (sourceMessageId: string, sourceRevision: number) => ({
    householdId: ticket.householdId, sourceMemberId: ticket.forMemberId, sourceMessageId, sourceRevision,
  });
  const original = readTicketSource(db, ticket.conversationId, proof(ticket.sourceMessageId, ticket.sourceRevision), policy);
  const inputs = db.select().from(ticketInputs).where(and(
    eq(ticketInputs.ticketId, ticket.id), isNull(ticketInputs.deletedAt),
  )).orderBy(asc(ticketInputs.hlc), asc(ticketInputs.id)).all();
  const inputTexts = inputs.map((input) => {
    if (input.memberId !== ticket.forMemberId) {
      throw new TicketError(409, "source_unavailable", "补充的话已不可使用");
    }
    if (input.sourceMessageId !== null && input.sourceRevision !== null) {
      return readTicketSource(db, ticket.conversationId, proof(input.sourceMessageId, input.sourceRevision), policy).text;
    }
    return input.text;
  });
  assertTicketTopic(db, ticket, [ticket.goal, original.text, ...inputTexts, ...extra], policy);
}

export function latestRun(db: Reader, ticketId: string): RunRow | undefined {
  return db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.generation)).limit(1).get();
}

export function canAdmitErrand(db: Reader, scope: Pick<TicketRow, "householdId" | "publisherHostId" | "forMemberId">, day: string): boolean {
  const grant = publicationProof(db, scope.householdId);
  const groupEpoch = grant?.holderHostId === scope.publisherHostId ? grant.epoch : null;
  const active = db.select({ id: tickets.id }).from(tickets)
    .innerJoin(conversations, eq(conversations.id, tickets.conversationId)).where(and(
      eq(tickets.householdId, scope.householdId), eq(tickets.publisherHostId, scope.publisherHostId),
      eq(tickets.kind, "errand"), eq(tickets.status, "open"), ne(tickets.stage, "queued"),
      isNull(tickets.deletedAt), isNull(conversations.deletedAt),
      or(eq(conversations.kind, "direct"), sql`coalesce(${tickets.publicationEpoch}, 1) = ${groupEpoch}`),
    )).limit(2).all();
  if (active.length === 2) {
    return false;
  }
  const admitted = db.select({ id: runs.id }).from(runs)
    .innerJoin(tickets, eq(runs.ticketId, tickets.id))
    .where(and(eq(tickets.householdId, scope.householdId), eq(tickets.forMemberId, scope.forMemberId),
      eq(runs.publisherHostId, scope.publisherHostId), eq(runs.localDay, day))).limit(5).all();
  return admitted.length < 5;
}

export function reviseTicket(db: ReplicationTx, clock: Clock, ticket: TicketRow, values: Partial<TicketRow>) {
  if (!currentHostOwnsTicket(db, ticket)) {
    throw new TicketError(409, "not_publisher", "请连接这件事的发布宿主");
  }
  const updated = db.update(tickets).set({ ...values, ...revision(clock), rev: ticket.rev + 1 })
    .where(eq(tickets.id, ticket.id)).returning().get()!;
  appendNativeChange(db, ticket.originHostId, ticket.householdId, replicaAdapters.ticket, updated);
  return updated;
}

function jobKey(ticket: TicketRow): string {
  return `ticket:${ticket.id}:${ticket.rev}`;
}

export function invalidateTicketJob(db: Pick<StoreDb, "update">, clock: Clock, ticket: TicketRow): void {
  supersedeJob(db, clock, ticket.kind, jobKey(ticket));
}

export function enqueueTicketJob(db: Pick<StoreDb, "transaction">, clock: Clock, ticket: TicketRow, run?: RunRow): void {
  if ((ticket.kind === "errand") !== Boolean(run)
    || (run && (run.ticketId !== ticket.id || run.publisherHostId !== ticket.publisherHostId))) {
    throw new Error("作业与事项执行代次不一致");
  }
  const identity = { ticketId: ticket.id, ticketRev: ticket.rev };
  const payload: TicketJob = run
    ? { kind: "errand", ...identity, runId: run.id, generation: run.generation }
    : { kind: "followup", ...identity };
  enqueueJob(db, clock, {
    queue: payload.kind, payload, dedupeKey: jobKey(ticket),
    runAt: ticket.dueAt ?? undefined,
  });
}

export function currentHostOwnsTicket(db: Reader, ticket: TicketRow): boolean {
  const hostId = getHostMeta(db, "host_id");
  const member = getMember(db, ticket.forMemberId);
  if (!hostId || ticket.publisherHostId !== hostId || member?.householdId !== ticket.householdId
    || !inLiveHousehold(db, ticket.householdId, hostId)) {
    return false;
  }
  const conversation = db.select().from(conversations).innerJoin(participants, eq(participants.conversationId, conversations.id))
    .where(and(
      eq(conversations.id, ticket.conversationId), eq(conversations.householdId, ticket.householdId),
      eq(participants.memberId, ticket.forMemberId), isNull(conversations.deletedAt), isNull(participants.deletedAt),
    )).get()?.conversations;
  if (!conversation) {
    return false;
  }
  if (conversation.kind === "direct") return conversation.ownerMemberId === member.id && member.homeHostId === hostId;
  const proof = publicationProof(db, ticket.householdId);
  return proof?.holderHostId === hostId && proof.epoch === (ticket.publicationEpoch ?? 1);
}

/** 在认领、写检查点或接受结果的事务内调用。执行许可另用 assertTicketMandate 核对。 */
export function getCurrentTicketExecution(db: Reader, job: TicketJob): { ticket: TicketRow; run?: RunRow } | undefined {
  const ticket = db.select().from(tickets).where(and(eq(tickets.id, job.ticketId), isNull(tickets.deletedAt))).get();
  if (!ticket || ticket.status !== "open" || ticket.kind !== job.kind || ticket.rev !== job.ticketRev
    || !currentHostOwnsTicket(db, ticket)) {
    return undefined;
  }
  if (job.kind === "followup") {
    return ticket.stage === "scheduled" ? { ticket } : undefined;
  }
  const run = latestRun(db, ticket.id);
  if (ticket.stage !== "thinking" || !run || run.status === "ended" || run.localDay === null
    || run.id !== job.runId || run.generation !== job.generation || run.publisherHostId !== ticket.publisherHostId) {
    return undefined;
  }
  return { ticket, run };
}

/** 扫描只打开一个排队事项，调用方提交后唤醒 errand 队列，有余量时可继续扫描。 */
export function admitQueuedErrands(db: StoreDb, clock: Clock, policy?: TicketAdmissionPolicy, authority?: GroupPublicationAuthority, window?: PublicationWindow): boolean {
  return db.transaction((tx) => {
    const hostId = getHostMeta(tx, "host_id");
    if (!hostId) {
      return false;
    }
    const queued = tx.select().from(tickets).where(and(
      eq(tickets.publisherHostId, hostId), eq(tickets.kind, "errand"), eq(tickets.status, "open"),
      eq(tickets.stage, "queued"), isNull(tickets.deletedAt),
    )).orderBy(asc(tickets.updatedAt), asc(tickets.id)).all();
    for (const ticket of queued) {
      const run = latestRun(tx, ticket.id);
      const day = localISO(clock.wallMs(), ticket.timeZone).slice(0, 10);
      if (run?.status !== "pending" || run.localDay !== null || run.publisherHostId !== hostId
        || !currentHostOwnsTicket(tx, ticket)
        || !currentConversationEpoch(tx, clock, ticket.conversationId, authority, window) || !canAdmitErrand(tx, ticket, day)) {
        continue;
      }
      try {
        assertTicketMandate(tx, ticket, policy);
      } catch (error) {
        if (error instanceof TicketError && (error.code === "source_unavailable" || error.code === "permission_denied")) {
          continue;
        }
        throw error;
      }
      const admitted = tx.update(runs).set({ localDay: day, updatedAt: clock.wallMs() })
        .where(eq(runs.id, run.id)).returning().get()!;
      enqueueTicketJob(tx, clock, reviseTicket(tx, clock, ticket, { stage: "thinking" }), admitted);
      return true;
    }
    return false;
  }, { behavior: "immediate" });
}
