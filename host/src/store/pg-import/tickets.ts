import { z } from "zod";
import { textSha256 } from "../../import-pg/values.ts";
import { decisions, mailboxLetters, mailboxReads, runs, ticketInputs, ticketPublications, tickets, triggers } from "../schema/index.ts";
import { checked } from "./audit.ts";
import { dictionary, integer, millis, nonEmpty, optionalMillis, string, validZone } from "./context.ts";
import type { ImportContext } from "./context.ts";
import { memberSource } from "./conversations.ts";
import type { ImportedMessages } from "./conversations.ts";

type Ticket = typeof tickets.$inferSelect;
type Trigger = typeof triggers.$inferSelect;
type Letter = typeof mailboxLetters.$inferSelect;

const endedStage: Record<string, Ticket["stage"]> = {
  asked: "completed", letter: "completed", ready: "completed", delivered: "completed",
  completed: "completed", failed: "failed", blocked: "blocked",
  dropped: "discarded", discarded: "discarded", cancelled: "cancelled",
};
const commandKinds = new Set(["schedule", "start", "reschedule", "append", "cancel"]);
const optionalReceiptText = (data: Record<string, unknown>, key: string) => nonEmpty(data[key]) ? data[key] : undefined;

export function importTickets(ctx: ImportContext, index: ImportedMessages, withdrawn: ReadonlySet<string>) {
  const { tx, memberId, scope, business, audit } = ctx;
  const nativeTickets = new Map<string, Ticket>();
  for (const legacy of ctx.rows("tickets")) {
    const row = legacy.data;
    const mandate = dictionary(row.mandate);
    const source = memberSource(ctx, index, row.source_message_id);
    const dueAt = optionalMillis(row.due_at);
    const kind = row.kind;
    const mandateKind = mandate?.kind;
    const timeZone = string(row.time_zone) ?? ctx.timeZone;
    const reject = kind !== "followup" && kind !== "errand" ? "unsupported_ticket_kind"
      : !source || mandate?.source_message_id !== source.legacy.key ? "mandate_unproven"
      : mandateKind !== "explicit" && !(kind === "followup" && mandateKind === "inferred"
        && mandate.source_hash === textSha256(source.target.text) && nonEmpty(mandate.rule_id)
        && typeof mandate.version === "number") ? "mandate_unproven"
      : !nonEmpty(row.goal) || !validZone(timeZone) || ((kind === "followup") !== (dueAt !== null)) ? "invalid_ticket"
      : undefined;
    if (reject || !source || (kind !== "followup" && kind !== "errand") || (mandateKind !== "explicit" && mandateKind !== "inferred")
      || !nonEmpty(row.goal)) {
      audit.reject("tickets", legacy, reject ?? "mandate_unproven");
      continue;
    }
    const revoked = withdrawn.has(source.legacy.key);
    // An imported follow-up can be explicitly rescheduled. A pre-import
    // errand can only start a new generation after the member resumes it.
    const stage: Ticket["stage"] | undefined = row.status === "ended" ? endedStage[string(row.stage) ?? ""]
      : revoked || mandateKind === "inferred" ? "discarded"
      : kind === "followup" ? "quiet_waiting" : "failed";
    if (!stage) {
      audit.reject("tickets", legacy, "unsupported_ticket_stage");
      continue;
    }
    const status = stage === "quiet_waiting" ? "open" : "ended";
    const endedReason = status === "open" ? null : nonEmpty(row.ended_reason) ? row.ended_reason
      : revoked ? "legacy_source_withdrawn" : row.status === "open" ? "legacy_import_paused" : null;
    const target: typeof tickets.$inferInsert = {
      ...business("ticket", legacy.key, millis(row.created_at), millis(row.updated_at)), ...scope,
      publicationEpoch: null, kind, mandateKind, sourceMessageId: source.target.id, sourceRevision: source.target.rev,
      goal: row.goal, status, stage, endedReason, dueAt, timeZone,
    };
    const stored = tx.insert(tickets).values(target).returning().get()!;
    nativeTickets.set(legacy.key, stored);
    audit.mapped("tickets", legacy, [checked("tickets", target, stored)], [
      "mandate", "local_day", "status", "stage", "ended_reason", "time_zone",
    ]);
  }

  const legacyDecisions = new Map<string, typeof ctx.user[]>();
  for (const row of ctx.rows("decisions")) {
    const key = string(row.data.trigger_id);
    if (!key) continue;
    const prior = legacyDecisions.get(key) ?? [];
    prior.push(row);
    legacyDecisions.set(key, prior);
  }

  const nativeTriggers: { legacy: typeof ctx.user; stored: Trigger }[] = [];
  for (const legacy of ctx.rows("triggers")) {
    const row = legacy.data;
    const payload = dictionary(row.payload);
    const receipt = dictionary(payload?.receipt);
    const command = dictionary(payload?.command);
    const kind = string(command?.kind) as Trigger["commandKind"] | undefined;
    const fingerprint = string(command?.fingerprint);
    const linkedDecision = legacyDecisions.get(legacy.key);
    const matchingDecision = linkedDecision?.length === 1 ? linkedDecision[0] : undefined;
    const ticket = nativeTickets.get(string(payload?.ticket_id) ?? "");
    const source = memberSource(ctx, index, payload?.message_id);
    if ((row.source !== "app" && row.source !== "chat") || !kind || !commandKinds.has(kind)
      || !fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint) || !nonEmpty(row.idempotency_key)
      || !ticket || matchingDecision?.data.ticket_id !== payload?.ticket_id || receipt?.ticket_id !== payload?.ticket_id
      || ((row.source === "chat" || payload?.message_id !== undefined) && !source)) {
      audit.reject("triggers", legacy, "command_proof_unavailable");
      continue;
    }
    const target: typeof triggers.$inferInsert = {
      ...business("trigger", legacy.key, millis(row.received_at)), householdId: scope.householdId,
      conversationId: scope.conversationId, actorMemberId: memberId, publisherHostId: scope.publisherHostId,
      source: row.source, sourceMessageId: source?.target.id ?? null, sourceRevision: source?.target.rev ?? null,
      idempotencyKey: `pg:${row.idempotency_key}`, commandKind: kind, fingerprint,
      receipt: {
        ticket_id: ticket.id,
        ...(typeof receipt?.queued === "boolean" ? { queued: receipt.queued } : {}),
        ...(optionalReceiptText(receipt!, "when") ? { when: string(receipt!.when)! } : {}),
        ...(optionalReceiptText(receipt!, "time_zone") ? { time_zone: string(receipt!.time_zone)! } : {}),
        ...(receipt?.saved === true ? { saved: true } : {}),
        ...(receipt?.resumed === true ? { resumed: true } : {}),
        ...(receipt?.cancelled === true ? { cancelled: true } : {}),
      },
    };
    const stored = tx.insert(triggers).values(target).returning().get()!;
    audit.mapped("triggers", legacy, [checked("triggers", target, stored)], ["idempotency_key", "payload"]);
    nativeTriggers.push({ legacy, stored });
    const decision = matchingDecision!;
    const { outcome, reasons } = decision.data;
    if ((outcome !== "accept" && outcome !== "attach") || !Array.isArray(reasons) || !reasons.every(nonEmpty)) {
      audit.reject("decisions", decision, "unsupported_decision");
      continue;
    }
    const projected: typeof decisions.$inferInsert = {
      ...business("decision", decision.key, millis(decision.data.created_at)), triggerId: stored.id,
      ticketId: ticket.id, outcome, reasons,
    };
    audit.mapped("decisions", decision, [checked("decisions", projected,
      tx.insert(decisions).values(projected).returning().get())], ["rule_version"]);
  }

  const usedTriggers = new Set<string>();
  for (const legacy of ctx.rows("ticket_inputs")) {
    const row = legacy.data;
    const ticket = nativeTickets.get(string(row.ticket_id) ?? "");
    const source = memberSource(ctx, index, row.message_id);
    const inputKind = ticket?.kind === "errand" ? "append" : "reschedule";
    const candidates = nativeTriggers.filter(({ stored, legacy: original }) => stored.receipt.ticket_id === ticket?.id
      && stored.commandKind === inputKind && stored.sourceMessageId === (source?.target.id ?? null)
      && millis(original.data.received_at) === millis(row.created_at));
    const trigger = candidates.length === 1 ? candidates[0]!.stored : undefined;
    if (!ticket || !trigger || usedTriggers.has(trigger.id) || !nonEmpty(row.text)
      || (row.message_id !== null && (!source || withdrawn.has(source.legacy.key)))) {
      audit.reject("ticket_inputs", legacy, "input_proof_unavailable");
      continue;
    }
    usedTriggers.add(trigger.id);
    const target = {
      ...business("ticket-input", legacy.key, millis(row.created_at)), ticketId: ticket.id,
      triggerId: trigger.id, memberId, kind: inputKind, sourceMessageId: source?.target.id ?? null,
      sourceRevision: source?.target.rev ?? null, text: row.text,
    } as const;
    audit.mapped("ticket_inputs", legacy, [checked("ticket_inputs", target, tx.insert(ticketInputs).values(target).returning().get())], ["read_at"]);
  }

  for (const legacy of ctx.rows("runs")) {
    const row = legacy.data;
    const ticket = nativeTickets.get(string(row.ticket_id) ?? "");
    if (!ticket || ticket.kind !== "errand") {
      audit.reject("runs", legacy, "ticket_unmapped");
      continue;
    }
    const createdAt = millis(row.created_at);
    const target = {
      id: ctx.id("run", legacy.key, createdAt), ticketId: ticket.id, publisherHostId: ctx.hostId,
      generation: integer(row.generation), status: "ended" as const, localDay: string(row.local_day) ?? null,
      outputTokens: integer(row.output_tokens), elapsedMs: integer(row.elapsed_ms),
      createdAt, updatedAt: Math.max(createdAt, optionalMillis(row.step_started_at) ?? createdAt),
    };
    audit.mapped("runs", legacy, [checked("runs", target, tx.insert(runs).values(target).returning().get())], [
      "status", "attempt", "lease_until", "report", "step_started_at",
    ]);
  }

  const letters = new Map<string, Letter>();
  for (const legacy of ctx.rows("mailbox_letters")) {
    const row = legacy.data;
    const ticket = nativeTickets.get(string(row.ticket_id) ?? "");
    if (!ticket || !nonEmpty(row.text)) {
      audit.reject("mailbox_letters", legacy, ticket ? "invalid_letter" : "ticket_unmapped");
      continue;
    }
    const base = business("mailbox", legacy.key, millis(row.created_at));
    const target = { ...base, ...scope, ticketId: ticket.id, text: row.text, createdHlc: base.hlc, readAt: null };
    const stored = tx.insert(mailboxLetters).values(target).returning().get()!;
    letters.set(legacy.key, stored);
    const result = [checked("mailbox_letters", target, stored)];
    const at = optionalMillis(row.read_at);
    if (at !== null) {
      const read = { ...business("mailbox-read", legacy.key, at, at, 1, stored.id),
        householdId: scope.householdId, letterId: stored.id, memberId, readAt: at };
      result.push(checked("mailbox_reads", read, tx.insert(mailboxReads).values(read).returning().get()));
    }
    audit.mapped("mailbox_letters", legacy, result, ["seq"]);
  }

  // The old outbox has no content ID. A unique committed row in the same
  // PostgreSQL transaction timestamp, with the same ticket and kind, proves the link.
  const sent = ctx.rows("outbox").filter(({ data }) => data.status === "sent");
  const proofTarget = (row: typeof ctx.user, ticket: Ticket) => {
    const match = (item: typeof row) => item.data.ticket_id === row.data.ticket_id && item.data.created_at === row.data.created_at;
    const targets = row.data.kind === "chat_message"
      ? [...index.values()].filter(({ legacy, target }) => match(legacy) && target.authorMemberId === null
        && target.replyToMessageId === ticket.sourceMessageId && target.status === "complete").map(({ target }) => target.id)
      : ctx.rows("mailbox_letters").filter(match).flatMap(({ key }) => letters.get(key)?.id ?? []);
    return targets.length === 1 ? targets[0] : undefined;
  };
  const usedPublications = new Set<string>();

  for (const legacy of ctx.rows("inferred_publications")) {
    const row = legacy.data;
    const ticket = nativeTickets.get(string(row.ticket_id) ?? "");
    if (!ticket || ticket.mandateKind !== "inferred" || ticket.stage !== "completed"
      || memberSource(ctx, index, row.source_message_id)?.target.id !== ticket.sourceMessageId
      || !z.iso.date().safeParse(row.local_day).success) {
      audit.reject("inferred_publications", legacy, "publication_proof_unavailable");
      continue;
    }
    const findDelivery = (purpose: string, kind: string) => {
      const candidates = sent.filter(({ data }) => data.ticket_id === row.ticket_id && data.purpose === purpose
        && data.kind === kind && data.created_at === row.created_at);
      return candidates.length === 1 ? proofTarget(candidates[0]!, ticket) : undefined;
    };
    const messageId = findDelivery("inferred:chat", "chat_message");
    const letterId = findDelivery("inferred:letter", "mailbox_letter");
    if (!messageId || !letterId || usedPublications.has(messageId) || usedPublications.has(letterId)) {
      audit.reject("inferred_publications", legacy, "publication_proof_unavailable");
      continue;
    }
    usedPublications.add(messageId);
    usedPublications.add(letterId);
    const target = {
      ...business("inferred-publication", legacy.key, millis(row.created_at)), householdId: scope.householdId,
      ticketId: ticket.id, ticketRev: ticket.rev, kind: "inference" as const, messageId, letterId,
      audienceDays: [{ memberId, localDay: string(row.local_day)! }],
    };
    audit.mapped("inferred_publications", legacy, [checked("ticket_publications", target,
      tx.insert(ticketPublications).values(target).returning().get())]);
  }

  for (const legacy of ctx.rows("outbox")) {
    const row = legacy.data;
    const ticket = nativeTickets.get(string(row.ticket_id) ?? "");
    if (row.status !== "sent" || (row.kind !== "chat_message" && row.kind !== "mailbox_letter")
      || !ticket || ticket.mandateKind !== "explicit") {
      audit.reject("outbox", legacy, "historical_delivery_only");
      continue;
    }
    const contentId = proofTarget(legacy, ticket);
    if (!contentId || usedPublications.has(contentId)) {
      audit.reject("outbox", legacy, "publication_proof_unavailable");
      continue;
    }
    usedPublications.add(contentId);
    const target = {
      ...business("publication", legacy.key, millis(row.created_at)), householdId: scope.householdId,
      ticketId: ticket.id, ticketRev: ticket.rev, kind: "worker" as const, audienceDays: [],
      messageId: row.kind === "chat_message" ? contentId : null, letterId: row.kind === "mailbox_letter" ? contentId : null,
    };
    audit.mapped("outbox", legacy, [checked("ticket_publications", target,
      tx.insert(ticketPublications).values(target).returning().get())], ["seq", "purpose", "kind", "status", "dropped_reason"]);
  }
}
