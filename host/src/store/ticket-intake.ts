import type { PublicationWindow } from "../publication/window.ts";
import { publicationProof } from "./publication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { appendNativeChange } from "./replication.ts";
import type { GroupPublicationAuthority } from "../router/types.ts";
import { publicationEpoch } from "./publication-authority.ts";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { uuidv7 } from "../ids/index.ts";
import { DEFAULT_TICKET_TIME_ZONE, localISO, parseTicketTime } from "../tickets/time.ts";
import { TicketError, ticketCommandSchema } from "../tickets/types.ts";
import type { SourceReference, TicketAdmissionPolicy, TicketCommand, TicketCommandContext } from "../tickets/types.ts";
import { businessRow } from "./business.ts";
import type { StoreDb } from "./index.ts";
import { decisions, runs, ticketInputs, tickets, triggers } from "./schema/tickets.ts";
import {
  assertTicketMandate, assertTicketTopic, canAdmitErrand, enqueueTicketJob, invalidateTicketJob, isResumable,
  latestRun, localTicketPublisher, readActorTicket, readTicketSource, reviseTicket, ticketConversation,
} from "./tickets.ts";
import type { RunRow, TicketRow } from "./tickets.ts";

export type TicketReceipt = typeof triggers.$inferSelect["receipt"];

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invalid(message: string): never {
  throw new TicketError(400, "invalid_request", message);
}

function notActionable(): never {
  throw new TicketError(409, "not_actionable", "这件事现在不能这样修改");
}

function dueTime(clock: Clock, when: string, timeZone: string) {
  const due = parseTicketTime(when, timeZone);
  if (due <= clock.wallMs()) {
    invalid("请选之后的时间");
  }
  return due;
}

function startRun(db: Pick<StoreDb, "insert">, clock: Clock, ticket: TicketRow, day: string | null, generation = 0): RunRow {
  const now = clock.wallMs();
  return db.insert(runs).values({
    id: uuidv7(clock), ticketId: ticket.id, publisherHostId: ticket.publisherHostId,
    generation, status: "pending", localDay: day, createdAt: now, updatedAt: now,
  }).returning().get()!;
}

type Outcome = {
  receipt: TicketReceipt;
  reasons: string[];
  queue?: TicketRow["kind"];
  input?: { kind: "append" | "reschedule"; text: string };
};

function chatTriggers(db: Pick<StoreDb, "select">, scope: {
  actor: TicketCommandContext["actor"]; conversationId: string; messageId: string;
}) {
  const { actor, conversationId, messageId } = scope;
  return db.select().from(triggers).where(and(
    eq(triggers.source, "chat"), eq(triggers.householdId, actor.householdId),
    eq(triggers.actorMemberId, actor.memberId), eq(triggers.conversationId, conversationId),
    eq(triggers.sourceMessageId, messageId), isNull(triggers.deletedAt),
  )).limit(2).all();
}

/** 重答与跨宿主交接只读原事项收据，同时复核原话修订与成员归属。 */
export function readChatTicketReceipt(
  db: Pick<StoreDb, "select">, scope: SourceReference & {
    actor: TicketCommandContext["actor"]; conversationId: string;
  }, policy?: TicketAdmissionPolicy,
) {
  const [event, extra] = chatTriggers(db, scope);
  if (!event || extra || event.sourceRevision !== scope.revision) return;
  const { actor, conversationId, messageId: sourceMessageId, revision: sourceRevision } = scope;
  const source = readTicketSource(db, conversationId, {
    householdId: actor.householdId, sourceMemberId: actor.memberId, sourceMessageId, sourceRevision,
  }, policy);
  const ticket = readActorTicket(db, actor, event.receipt.ticket_id);
  if (ticket.conversationId !== conversationId) return;
  assertTicketTopic(db, ticket, [source.text, ticket.goal], policy);
  return { kind: event.commandKind, receipt: event.receipt };
}

export function receiveTicketCommand(
  db: StoreDb, clock: Clock, context: TicketCommandContext, command: TicketCommand, policy?: TicketAdmissionPolicy, authority?: GroupPublicationAuthority, window?: PublicationWindow,
): { receipt: TicketReceipt; queue?: TicketRow["kind"] } {
  const { actor, origin } = context;
  const reference = origin.source === "chat" ? origin : origin.proof;
  return db.transaction((tx) => {
    if (origin.source === "chat") context.assertChatTurn?.(tx);
    const existing = "ticketId" in command ? readActorTicket(tx, actor, command.ticketId) : undefined;
    const conversationId = existing?.conversationId ?? context.conversationId;
    if (!conversationId || (context.conversationId !== undefined && context.conversationId !== conversationId)) {
      throw new TicketError(404, "not_found", "没有这件事");
    }
    const conversation = ticketConversation(tx, actor, conversationId);
    const hostId = localTicketPublisher(tx, actor.householdId, conversation.publisherHostId, existing?.publisherHostId);
    if (actor.hostId !== hostId) {
      throw new TicketError(409, "not_publisher", "请连接这件事的发布宿主");
    }
    const scope = { householdId: actor.householdId, conversationId, forMemberId: actor.memberId, publisherHostId: hostId };
    const source = reference && readTicketSource(tx, conversationId, {
      householdId: actor.householdId, sourceMemberId: actor.memberId,
      sourceMessageId: reference.messageId, sourceRevision: reference.revision,
    }, policy);
    if (!existing && !source) {
      invalid("请提供本人在该会话中的原话");
    }

    // 同一条补充始终以原话计入指纹，避免模型改写时重复保存。
    const effective = command.kind === "append" && source ? { ...command, text: source.text } : command;
    if (origin.source === "chat" && effective.kind === "append" && !ticketCommandSchema.safeParse(effective).success) {
      invalid("补充原话超出事项限制");
    }
    const hash = fingerprint([conversationId, source?.id, source?.rev, effective]);
    const identity = origin.source === "app" ? origin.requestId ?? uuidv7(clock)
      : existing ? fingerprint([source!.id, command.kind, existing.id]) : hash;
    const priorChat = origin.source === "chat"
      ? chatTriggers(tx, { actor, conversationId, messageId: origin.messageId }) : [];
    const replay = origin.source === "chat" ? priorChat[0] : tx.select().from(triggers).where(and(
      eq(triggers.householdId, actor.householdId), eq(triggers.actorMemberId, actor.memberId),
      eq(triggers.source, origin.source), eq(triggers.idempotencyKey, identity), isNull(triggers.deletedAt),
    )).get();
    if (replay) {
      if (priorChat.length > 1 || replay.fingerprint !== hash) {
        throw new TicketError(409, "idempotency_conflict", "同一请求标识不能用于不同操作");
      }
      if (replay.publisherHostId !== hostId) {
        throw new TicketError(409, "not_publisher", "请连接这件事的发布宿主");
      }
      return { receipt: replay.receipt };
    }

    if (conversation.kind === "group" && !publicationEpoch(tx, clock, conversation, authority, window)) {
      throw new TicketError(409, "not_publisher", "群聊发布宿主暂不可用");
    }

    const epoch = conversation.kind === "group" ? publicationProof(tx, conversation.householdId)?.epoch ?? null : null;
    if (existing && (existing.publicationEpoch ?? (epoch === null ? null : 1)) !== epoch) {
      return notActionable();
    }

    function timeZone(fallback = DEFAULT_TICKET_TIME_ZONE): string {
      return policy?.timeZone?.(tx, actor) ?? fallback;
    }

    function create(): Outcome {
      if (command.kind !== "schedule" && command.kind !== "start") {
        return notActionable();
      }
      const zone = timeZone();
      const goal = command.kind === "schedule" ? command.about : command.goal;
      assertTicketTopic(tx, scope, [goal, source!.text], policy);
      const values = {
        ...businessRow(clock, hostId), ...scope, publicationEpoch: epoch, goal, timeZone: zone, status: "open",
        mandateKind: "explicit", sourceMessageId: source!.id, sourceRevision: source!.rev,
      } as const;
      if (command.kind === "schedule") {
        const dueAt = dueTime(clock, command.when, zone);
        const ticket = tx.insert(tickets).values({ ...values, kind: "followup", stage: "scheduled", dueAt }).returning().get()!;
        appendNativeChange(tx, hostId, actor.householdId, replicaAdapters.ticket, ticket);
        enqueueTicketJob(tx, clock, ticket);
        return {
          receipt: { ticket_id: ticket.id, when: localISO(dueAt, zone), time_zone: zone },
          reasons: ["用户明确约定"], queue: "followup",
        };
      }
      const day = localISO(clock.wallMs(), zone).slice(0, 10);
      const queued = !canAdmitErrand(tx, scope, day);
      const ticket = tx.insert(tickets).values({ ...values, kind: "errand", stage: queued ? "queued" : "thinking" }).returning().get()!;
      appendNativeChange(tx, hostId, actor.householdId, replicaAdapters.ticket, ticket);
      const run = startRun(tx, clock, ticket, queued ? null : day);
      if (!queued) {
        enqueueTicketJob(tx, clock, ticket, run);
      }
      return {
        receipt: { ticket_id: ticket.id, queued }, queue: queued ? undefined : "errand",
        reasons: ["用户明确托付", queued ? "预算排队" : "开始执行"],
      };
    }

    function change(ticket: TicketRow): Outcome {
      const receipt = { ticket_id: ticket.id };
      const resuming = isResumable(ticket);
      if (ticket.status !== "open" && !resuming) {
        return notActionable();
      }
      if (effective.kind === "cancel") {
        invalidateTicketJob(tx, clock, ticket);
        reviseTicket(tx, clock, ticket, { status: "ended", stage: "cancelled", endedReason: "cancelled" });
        const run = latestRun(tx, ticket.id);
        if (run && run.status !== "ended") {
          tx.update(runs).set({ status: "ended", updatedAt: clock.wallMs() }).where(eq(runs.id, run.id)).run();
        }
        return { receipt: { ...receipt, cancelled: true }, reasons: ["用户取消"] };
      }
      if (effective.kind === "reschedule" && ticket.kind === "followup") {
        const zone = timeZone(ticket.timeZone);
        const dueAt = dueTime(clock, effective.when, zone);
        assertTicketMandate(tx, ticket, policy, source ? [source.text] : []);
        invalidateTicketJob(tx, clock, ticket);
        const updated = reviseTicket(tx, clock, ticket, { dueAt, timeZone: zone, stage: "scheduled" });
        enqueueTicketJob(tx, clock, updated);
        return {
          receipt: { ...receipt, when: localISO(dueAt, zone), time_zone: zone },
          queue: "followup", reasons: ["用户改期"],
          input: source ? { kind: "reschedule", text: source.text } : undefined,
        };
      }
      if (effective.kind !== "append" || ticket.kind !== "errand") {
        return notActionable();
      }
      const run = latestRun(tx, ticket.id);
      if (!run || run.publisherHostId !== hostId || (resuming && run.status !== "ended")) {
        return notActionable();
      }
      assertTicketMandate(tx, ticket, policy, [effective.text]);
      if (resuming) {
        const zone = timeZone(ticket.timeZone);
        const day = localISO(clock.wallMs(), zone).slice(0, 10);
        const queued = !canAdmitErrand(tx, scope, day);
        invalidateTicketJob(tx, clock, ticket);
        const updated = reviseTicket(tx, clock, ticket, {
          status: "open", stage: queued ? "queued" : "thinking", endedReason: null, timeZone: zone,
        });
        const next = startRun(tx, clock, updated, queued ? null : day, run.generation + 1);
        if (!queued) {
          enqueueTicketJob(tx, clock, updated, next);
        }
        return {
          receipt: { ...receipt, saved: true, resumed: true, queued }, queue: queued ? undefined : "errand",
          reasons: ["用户继续原托付", queued ? "预算排队" : "重新执行"],
          input: { kind: "append", text: effective.text },
        };
      }
      const queued = ticket.stage === "queued";
      invalidateTicketJob(tx, clock, ticket);
      const updated = reviseTicket(tx, clock, ticket, { stage: queued ? "queued" : "thinking" });
      if (!queued) {
        const pending = tx.update(runs).set({ status: "pending", updatedAt: clock.wallMs() })
          .where(eq(runs.id, run.id)).returning().get()!;
        enqueueTicketJob(tx, clock, updated, pending);
      }
      return {
        receipt: { ...receipt, saved: true }, queue: queued ? undefined : "errand",
        reasons: ["用户补充"], input: { kind: "append", text: effective.text },
      };
    }

    const result = existing ? change(existing) : create();
    const event = tx.insert(triggers).values({
      ...businessRow(clock, hostId), householdId: actor.householdId, conversationId,
      actorMemberId: actor.memberId, publisherHostId: hostId, source: origin.source,
      sourceMessageId: source?.id, sourceRevision: source?.rev,
      idempotencyKey: identity, commandKind: command.kind, fingerprint: hash, receipt: result.receipt,
    }).returning().get()!;
    appendNativeChange(tx, hostId, actor.householdId, replicaAdapters.ticket_trigger, event);
    const decision = tx.insert(decisions).values({
      ...businessRow(clock, hostId), triggerId: event.id, ticketId: result.receipt.ticket_id,
      outcome: existing ? "attach" : "accept", reasons: result.reasons,
    }).returning().get()!;
    appendNativeChange(tx, hostId, actor.householdId, replicaAdapters.ticket_decision, decision);
    if (result.input) {
      const input = tx.insert(ticketInputs).values({
        ...businessRow(clock, hostId), ticketId: result.receipt.ticket_id, triggerId: event.id,
        memberId: actor.memberId, sourceMessageId: source?.id, sourceRevision: source?.rev, ...result.input,
      }).returning().get()!;
      appendNativeChange(tx, hostId, actor.householdId, replicaAdapters.ticket_input, input);
    }
    return { receipt: result.receipt, queue: result.queue };
  }, { behavior: "immediate" });
}
