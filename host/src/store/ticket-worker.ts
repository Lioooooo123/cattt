import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { PublicationWindow } from "../publication/window.ts";
import type { GroupPublicationAuthority } from "../router/types.ts";
import { conversationHead } from "./conversation-publication.ts";
import { currentConversationEpoch } from "./publication-authority.ts";
import type { Clock } from "../clock/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { ConversationHead, TicketWorkerContext, WorkerDependency, WorkerResult } from "../ticket-workers/types.ts";
import { ERRAND_BUDGET, TicketError } from "../tickets/types.ts";
import type { SourceProof, TicketAdmissionPolicy, TicketJob } from "../tickets/types.ts";
import type { StoreDb } from "./index.ts";
import { getHeldJob } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { runSteps, workerReports } from "./schema/ticket-worker.ts";
import { runs, ticketInputs, tickets } from "./schema/tickets.ts";
import { assertTicketMandate, currentHostOwnsTicket, getCurrentTicketExecution, latestRun, readTicketSource, reviseTicket } from "./tickets.ts";
import type { RunRow, TicketRow } from "./tickets.ts";

export class ExecutionStopped extends Error {}
export class ExecutionPublicationPending extends Error {}
export class ExecutionPermissionChanged extends Error {}

type Execution = { ticket: TicketRow; run?: RunRow };
type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "update">;
type Step = Omit<typeof runSteps.$inferInsert, "runId" | "ticketRev" | "createdAt" | "conversationHead">;
export type WorkerReport = typeof workerReports.$inferSelect;

export interface ExecutionFence {
  attempt: Job;
  payload: TicketJob;
  clock: Clock;
  policy?: TicketAdmissionPolicy;
  groupAuthority?: GroupPublicationAuthority;
  publication?: PublicationWindow;
  context?: TicketWorkerContext;
}

export function assertExecution(db: Reader, fence: ExecutionFence): Execution {
  const job = getHeldJob(db, fence.clock, fence.attempt);
  const execution = getCurrentTicketExecution(db, fence.payload);
  if (!execution || !job || job.queue !== fence.payload.kind || job.payload !== fence.attempt.payload) {
    throw new ExecutionStopped();
  }
  if (!currentConversationEpoch(db, fence.clock, execution.ticket.conversationId, fence.groupAuthority, fence.publication)) {
    throw new ExecutionPublicationPending();
  }
  return execution;
}

export function assertExecutionPermission(
  db: Reader, fence: ExecutionFence, ticket: TicketRow, dependencies: readonly WorkerDependency[] = [],
  extra: readonly string[] = [],
): void {
  try {
    assertTicketMandate(db, ticket, fence.policy, extra);
  } catch (error) {
    if (error instanceof TicketError && ["source_unavailable", "permission_denied"].includes(error.code)) {
      throw new ExecutionPermissionChanged();
    }
    throw error;
  }
  if (dependencies.length && !fence.context?.permits(db, ticket, dependencies)) {
    throw new ExecutionPermissionChanged();
  }
}

function proof(ticket: TicketRow, sourceMessageId: string, sourceRevision: number): SourceProof {
  return {
    householdId: ticket.householdId, sourceMemberId: ticket.forMemberId, sourceMessageId, sourceRevision,
  };
}

function inputs(db: Reader, ticketId: string) {
  return db.select().from(ticketInputs).where(and(
    eq(ticketInputs.ticketId, ticketId), isNull(ticketInputs.deletedAt),
  )).orderBy(asc(ticketInputs.hlc), asc(ticketInputs.id)).all();
}

export function readExecutionInput(db: Reader, ticket: TicketRow, policy?: TicketAdmissionPolicy) {
  const source = proof(ticket, ticket.sourceMessageId, ticket.sourceRevision);
  const original = readTicketSource(db, ticket.conversationId, source, policy);
  const supplements = inputs(db, ticket.id).map((input) => ({
    id: input.id,
    text: input.text,
    source: input.sourceMessageId && input.sourceRevision
      ? proof(ticket, input.sourceMessageId, input.sourceRevision) : undefined,
  }));
  return { original: original.text, source, supplements };
}

export function assertExecutionInputs(db: Reader, ticket: TicketRow, usedIds: readonly string[]): void {
  if (!usedIds.length) { return; }
  const allowed = new Set(inputs(db, ticket.id).map(({ id }) => id));
  if (usedIds.some((id) => !allowed.has(id))) { throw new ExecutionPermissionChanged(); }
}

export function readConversationHead(
  db: Reader, ticket: TicketRow, clock: Clock, authority?: GroupPublicationAuthority, window?: PublicationWindow,
): ConversationHead {
  return {
    ...conversationHead(db, ticket.conversationId),
    publicationEpoch: currentConversationEpoch(db, clock, ticket.conversationId, authority, window),
  };
}

export function assertExecutionHead(db: Reader, fence: ExecutionFence, ticket: TicketRow, head: ConversationHead) {
  const current = currentConversationEpoch(db, fence.clock, ticket.conversationId, fence.groupAuthority, fence.publication);
  if (!current || current !== head.publicationEpoch) throw new ExecutionStopped();
}

export function lastRunStep(db: Reader, runId: string) {
  return db.select().from(runSteps).where(eq(runSteps.runId, runId))
    .orderBy(desc(runSteps.step)).limit(1).get();
}

export function hadToolCorrection(db: Reader, runId: string): boolean {
  return db.select({ usage: runSteps.usage }).from(runSteps).where(eq(runSteps.runId, runId)).all()
    .some(({ usage }) => usage.toolValidationFailed);
}

export function reviseRun(db: Writer, clock: Clock, run: RunRow, values: Partial<RunRow>): void {
  db.update(runs).set({ ...values, updatedAt: clock.wallMs() }).where(eq(runs.id, run.id)).run();
}

export function discardExecution(db: StoreDb, fence: ExecutionFence): void {
  db.transaction((tx) => {
    const { ticket, run } = assertExecution(tx, fence);
    if (run) {
      reviseRun(tx, fence.clock, run, { status: "ended" });
    }
    reviseTicket(tx, fence.clock, ticket, { status: "ended", stage: "discarded", endedReason: "permission_changed" });
  }, { behavior: "immediate" });
}

const reportStage = {
  ready: "completed", waiting: "waiting", failed: "failed", blocked: "blocked", dropped: "discarded", due: "completed",
} as const;

export function commitWorkerResult(db: StoreDb, fence: ExecutionFence, input: {
  result?: WorkerResult;
  step?: Step;
  dependencies: WorkerDependency[];
  head: ConversationHead;
}): WorkerReport | undefined {
  return db.transaction((tx) => {
    const { ticket, run } = assertExecution(tx, fence);
    const { result, step, dependencies, head } = input;
    assertExecutionHead(tx, fence, ticket, head);
    const extra = result && ("result" in result ? [result.result] : "question" in result ? [result.question]
      : "reason" in result ? [result.reason] : []);
    assertExecutionPermission(tx, fence, ticket, dependencies, extra || []);
    const now = fence.clock.wallMs();
    if (step) {
      if (!run || step.step > ERRAND_BUDGET.steps) {
        throw new Error("无效的执行检查点");
      }
      tx.insert(runSteps).values({
        ...step, runId: run.id, ticketRev: ticket.rev, conversationHead: head, createdAt: now,
      }).run();
    }
    if (!result) {
      return;
    }
    if (run) {
      reviseRun(tx, fence.clock, run, { status: result.status === "waiting" ? "pending" : "ended" });
    }
    const { source, supplements } = readExecutionInput(tx, ticket, fence.policy);
    const waiting = result.status === "waiting";
    const updated = reviseTicket(tx, fence.clock, ticket, {
      status: waiting ? "open" : "ended",
      stage: reportStage[result.status],
      endedReason: waiting ? null : result.status,
    });
    return tx.insert(workerReports).values({
      id: uuidv7(fence.clock), ticketId: ticket.id, ticketRev: ticket.rev, resultTicketRev: updated.rev,
      householdId: ticket.householdId, conversationId: ticket.conversationId, forMemberId: ticket.forMemberId,
      publisherHostId: ticket.publisherHostId, kind: ticket.kind, runId: run?.id, generation: run?.generation,
      jobId: fence.attempt.id, jobAttempt: fence.attempt.attempts,
      result, sourceProofs: [source, ...supplements.flatMap((input) => input.source ? [input.source] : [])],
      dependencies, conversationHead: head, dueAt: ticket.dueAt, timeZone: ticket.timeZone,
      quietAfter: waiting ? now + 86_400_000 : null,
      createdAt: now,
    }).returning().get()!;
  }, { behavior: "immediate" });
}

/** Router 用宿主和报告游标扫描，提交后唤醒可丢失。 */
export function listWorkerReports(db: Reader, publisherHostId: string, after?: number, limit = 100): WorkerReport[] {
  return db.select().from(workerReports).where(and(
    eq(workerReports.publisherHostId, publisherHostId),
    after === undefined ? undefined : gt(workerReports.sequence, after),
  )).orderBy(asc(workerReports.sequence)).limit(limit).all();
}

/** Router 可在自己的发布事务中重新定位报告所针对的当前事项。 */
export function readReportTicket(db: Reader, report: WorkerReport): TicketRow | undefined {
  const ticket = db.select().from(tickets).where(and(
    eq(tickets.id, report.ticketId), eq(tickets.rev, report.resultTicketRev),
    eq(tickets.householdId, report.householdId), eq(tickets.conversationId, report.conversationId),
    eq(tickets.forMemberId, report.forMemberId), eq(tickets.publisherHostId, report.publisherHostId),
    eq(tickets.kind, report.kind), eq(tickets.stage, reportStage[report.result.status]), isNull(tickets.deletedAt),
  )).get();
  if (!ticket || ticket.dueAt !== report.dueAt || ticket.timeZone !== report.timeZone) {
    return;
  }
  if (report.runId !== null) {
    const run = latestRun(db, ticket.id);
    const status = report.result.status === "waiting" ? "pending" : "ended";
    if (run?.id !== report.runId || run.generation !== report.generation
      || run.publisherHostId !== ticket.publisherHostId || run.status !== status) {
      return;
    }
  }
  return ticket;
}

export function readCurrentReportTicket(db: Reader, report: WorkerReport): TicketRow | undefined {
  const ticket = readReportTicket(db, report);
  return ticket && currentHostOwnsTicket(db, ticket) ? ticket : undefined;
}
