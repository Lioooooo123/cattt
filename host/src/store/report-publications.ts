import { and, asc, eq, lte } from "drizzle-orm";
import { uuidv7 } from "../ids/index.ts";
import type { Actor } from "../identity/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { availableAt } from "../tickets/time.ts";
import { TicketError } from "../tickets/types.ts";
import { activeConversation, freshConversation, writePublicationDelivery } from "./conversation-publication.ts";
import { publicationEpoch } from "./publication-authority.ts";
import { getHostMeta, setHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { enrolledPushDevices } from "./device-push.ts";
import { getMember } from "./identity.ts";
import { conversations } from "./schema/index.ts";
import { publicationReceipts, pushOutbox } from "./schema/publications.ts";
import { workerReports } from "./schema/ticket-worker.ts";
import { listWorkerReports, readExecutionInput, readReportTicket } from "./ticket-worker.ts";
import type { WorkerReport } from "./ticket-worker.ts";
import { assertTicketMandate, currentHostOwnsTicket, readTicketSource, reviseTicket } from "./tickets.ts";
import type { TicketRow } from "./tickets.ts";

type Reader = Pick<StoreDb, "select">;
export type PublicationReceipt = typeof publicationReceipts.$inferSelect;
export const publicationBatch = 100;
export const dayMs = 86_400_000;

export function discoverReports(ctx: HostContext): number {
  return ctx.store.db.transaction((tx) => {
    const key = `publication_report_cursor:${ctx.hostId}`;
    const cursor = Number(getHostMeta(tx, key) ?? "0");
    const reports = listWorkerReports(tx, ctx.hostId, cursor, publicationBatch);
    if (reports.length) {
      tx.insert(publicationReceipts).values(reports.map((report) => ({
        reportId: report.id, ticketId: report.ticketId, hostId: ctx.hostId,
        status: "pending" as const, retryAt: ctx.clock.wallMs(),
      }))).onConflictDoNothing().run();
      setHostMeta(tx, key, String(reports.at(-1)!.sequence));
    }
    return reports.length;
  }, { behavior: "immediate" });
}

export function duePublications(ctx: HostContext): string[] {
  return ctx.store.db.select({ id: publicationReceipts.reportId }).from(publicationReceipts).where(and(
    eq(publicationReceipts.hostId, ctx.hostId),
    eq(publicationReceipts.status, "pending"),
    lte(publicationReceipts.retryAt, ctx.clock.wallMs()),
  )).orderBy(asc(publicationReceipts.retryAt), asc(publicationReceipts.reportId)).limit(publicationBatch).all()
    .map(({ id }) => id);
}

export function getWorkerReport(db: Reader, reportId: string): WorkerReport | undefined {
  return db.select().from(workerReports).where(eq(workerReports.id, reportId)).get();
}

function reportText(report: WorkerReport) {
  switch (report.result.status) {
    case "due":
      return [report.result.about];
    case "ready":
      return [report.result.result];
    case "waiting":
      return [report.result.question];
    case "failed":
    case "blocked":
      return [report.result.reason];
    case "dropped":
      return [];
  }
}

function verifySources(ctx: HostContext, db: Reader, ticket: TicketRow, report: WorkerReport, text: readonly string[]) {
  const policy = ctx.config.ticketAdmission;
  const { source, supplements } = readExecutionInput(db, ticket, policy);
  const proofs = [source, ...supplements.flatMap((input) => input.source ? [input.source] : [])];
  const key = (proof: typeof source) => JSON.stringify([
    proof.householdId, proof.sourceMemberId, proof.sourceMessageId, proof.sourceRevision,
  ]);
  const expected = proofs.map(key).sort();
  const actual = report.sourceProofs.map(key).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new TicketError(409, "source_unavailable", "汇报的原话与当前事项不一致");
  }
  const external = report.dependencies.filter((dependency) => dependency.kind !== "message");
  const context = ctx.config.ticketWorkerContext;
  if (report.dependencies.length && (context ? !context.permits(db, ticket, report.dependencies) : external.length > 0)) {
    throw new TicketError(409, "source_unavailable", "汇报依赖的资料已不可使用");
  }
  const messageTexts = report.dependencies.filter((dependency) => dependency.kind === "message").map((dependency) => {
    if (dependency.memberId && dependency.memberId !== ticket.forMemberId) {
      throw new TicketError(409, "source_unavailable", "汇报依赖的原话归属不一致");
    }
    return readTicketSource(db, ticket.conversationId, {
      householdId: ticket.householdId, sourceMemberId: ticket.forMemberId,
      sourceMessageId: dependency.id, sourceRevision: dependency.revision,
    }, policy).text;
  });
  assertTicketMandate(db, ticket, policy, [...messageTexts, ...reportText(report), ...text]);
}

export type PublicationReview =
  | { reason: string }
  | { ticket: TicketRow; timeZone: string };

export function reviewPublication(ctx: HostContext, db: Reader, report: WorkerReport, text: readonly string[]): PublicationReview {
  const ticket = readReportTicket(db, report);
  if (!ticket) {
    return { reason: "ticket_changed" };
  }
  if (report.publisherHostId !== ctx.hostId || report.householdId !== ctx.householdId) {
    return { reason: "wrong_publisher" };
  }
  const conversation = db.select().from(conversations).where(eq(conversations.id, report.conversationId)).get()!;
  if (conversation.kind === "group") {
    const epoch = publicationEpoch(db, ctx.clock, conversation, ctx.config.groupPublicationAuthority, ctx.publication);
    if (!epoch || epoch !== report.conversationHead.publicationEpoch) {
      return { reason: "group_lease_unavailable" };
    }
  }
  if (!currentHostOwnsTicket(db, ticket)) return { reason: "wrong_publisher" };
  try {
    verifySources(ctx, db, ticket, report, text);
  } catch (error) {
    if (error instanceof TicketError && (error.code === "source_unavailable" || error.code === "permission_denied")) {
      return { reason: error.code };
    }
    throw error;
  }
  if (!freshConversation(db, conversation, report.conversationHead)) {
    return { reason: "conversation_changed" };
  }
  const actor: Pick<Actor, "householdId" | "memberId" | "hostId"> = {
    householdId: ticket.householdId, memberId: ticket.forMemberId, hostId: ctx.hostId,
  };
  const timeZone = ctx.config.ticketAdmission?.publicationTimeZone?.(db, actor) ?? ticket.timeZone;
  return { ticket, timeZone };
}

function buildDelivery(report: WorkerReport, overdue: boolean): {
  chat?: string; letter?: string; push?: "followup_due" | "errand_ready" | "errand_waiting";
} {
  switch (report.result.status) {
    case "due": {
      const prompt = `之前说好聊「${report.result.about}」，你现在想聊吗？`;
      return overdue
        ? { letter: `之前说好聊「${report.result.about}」。错过了约定的时间，等你想聊时我在。` }
        : { chat: prompt, letter: prompt, push: "followup_due" };
    }
    case "ready":
      return { chat: "我整理了一些想法，放在信箱里了。", letter: report.result.result, push: "errand_ready" };
    case "waiting":
      return { chat: report.result.question, push: "errand_waiting" };
    case "failed":
    case "blocked": {
      const text = `这件事还没办好。${report.result.reason}`;
      return overdue ? { letter: text } : { chat: text };
    }
    case "dropped":
      return {};
  }
}

export function publishReport(ctx: HostContext, reportId: string): PublicationReceipt | undefined {
  return ctx.store.db.transaction((tx) => {
    const now = ctx.clock.wallMs();
    const receipt = tx.select().from(publicationReceipts).where(and(
      eq(publicationReceipts.reportId, reportId), eq(publicationReceipts.hostId, ctx.hostId),
    )).get();
    if (!receipt || receipt.status !== "pending" || receipt.retryAt! > now) {
      return receipt;
    }
    const report = getWorkerReport(tx, reportId)!;
    const update = (values: Partial<PublicationReceipt>) => tx.update(publicationReceipts)
      .set(values).where(eq(publicationReceipts.reportId, reportId)).returning().get()!;
    const drop = (reason: string) => update({ status: "dropped", reason, retryAt: null, resolvedAt: now });
    const defer = (reason: string, retryAt: number) => update({ reason, retryAt });
    const overdueAt = report.dueAt === null ? Infinity : report.dueAt + dayMs + 1;
    const overdue = now >= overdueAt || (report.result.status === "due" && report.result.delivery === "mailbox_only");
    const delivery = buildDelivery(report, overdue);
    const text = [delivery.chat, delivery.letter].filter((line) => line !== undefined);
    const check = reviewPublication(ctx, tx, report, text);
    if ("reason" in check) {
      return drop(check.reason);
    }
    if (report.result.status === "dropped") {
      return drop("worker_dropped");
    }
    if (report.result.status === "waiting" && report.quietAfter !== null && now >= report.quietAfter) {
      reviseTicket(tx, ctx.clock, check.ticket, { stage: "quiet_waiting" });
      return drop("question_expired");
    }
    if (report.dueAt !== null && now < report.dueAt) {
      return defer("not_due", report.dueAt);
    }
    const allowedAt = overdue ? now : availableAt(now, check.timeZone);
    const expiration = Math.min(overdueAt, report.quietAfter ?? Infinity);
    if (allowedAt > now) {
      return defer("quiet_hours", Math.min(allowedAt, expiration));
    }
    if (delivery.chat && activeConversation(tx, report.conversationId)) {
      return defer("conversation_busy", Math.min(now + 1000, expiration));
    }
    const { messageId, letterId } = writePublicationDelivery(tx, ctx.clock, {
      hostId: ctx.hostId, householdId: report.householdId, conversationId: report.conversationId,
      forMemberId: report.forMemberId, ticketId: report.ticketId, sourceMessageId: check.ticket.sourceMessageId,
    }, delivery, { epoch: check.ticket.publicationEpoch, ticketRev: check.ticket.rev, kind: "worker" });
    const published = update({ status: "published", reason: null, retryAt: null, resolvedAt: now, messageId, letterId });
    if (ctx.config.publicationPush && delivery.push && messageId
      && getMember(tx, report.forMemberId)?.homeHostId === ctx.hostId
      && (!ctx.config.apns || enrolledPushDevices(ctx, tx, report.forMemberId, ctx.config.apns.topic).length > 0)) {
      tx.insert(pushOutbox).values({
        id: uuidv7(ctx.clock), reportId, hostId: ctx.hostId, memberId: report.forMemberId,
        status: "pending", retryAt: now, createdAt: now, updatedAt: now,
      }).run();
    }
    return published;
  }, { behavior: "immediate" });
}
