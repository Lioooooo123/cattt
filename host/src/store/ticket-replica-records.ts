import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { businessFields, businessId } from "../replication/types.ts";
import type { ReplicationSource } from "../replication/types.ts";
import { publicationIsSealed, publicationProof } from "./publication.ts";
import { assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter, requireReplicaDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { conversationInHousehold, memberInHousehold } from "./replica-scope.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { mailboxLetters, mailboxReads, ticketPublications } from "./schema/publications.ts";
import { decisions, ticketInputs, tickets, triggers } from "./schema/tickets.ts";

type Ticket = typeof tickets.$inferSelect;
const positive = z.int().positive();
const millis = z.int().nonnegative();
const text = z.string().min(1);
const scope = { householdId: businessId, conversationId: businessId, forMemberId: businessId, publisherHostId: businessId };

function ticket(tx: ReplicationTx, id: string) {
  return requireReplicaDependency(tx.select().from(tickets).where(eq(tickets.id, id)).get(), "ticket", id);
}

function trigger(tx: ReplicationTx, id: string) {
  return requireReplicaDependency(tx.select().from(triggers).where(eq(triggers.id, id)).get(), "ticket_trigger", id);
}

function letter(tx: ReplicationTx, id: string) {
  return requireReplicaDependency(tx.select().from(mailboxLetters).where(eq(mailboxLetters.id, id)).get(), "mailbox_letter", id);
}

function message(tx: ReplicationTx, id: string) {
  return requireReplicaDependency(tx.select().from(messages).where(eq(messages.id, id)).get(), "message", id);
}

function authorizeTicket(tx: ReplicationTx, source: ReplicationSource, row: Ticket) {
  assertReplicaWriter(row.householdId === source.householdId
    && row.publisherHostId === source.sourceHostId && row.originHostId === source.sourceHostId);
  const conversation = conversationInHousehold(tx, source, row.conversationId);
  const member = memberInHousehold(tx, row.forMemberId, row.householdId);
  requireReplicaDependency(tx.select({ id: participants.id }).from(participants).where(and(
    eq(participants.conversationId, row.conversationId), eq(participants.memberId, row.forMemberId),
  )).get(), "participant", `${row.conversationId}/${row.forMemberId}`);
  if (conversation.kind === "direct") {
    assertReplicaWriter(row.publicationEpoch === null && conversation.ownerMemberId === member.id && member.homeHostId === source.sourceHostId);
    return;
  }
  const epoch = row.publicationEpoch ?? 1;
  const proof = requireReplicaDependency(publicationProof(tx, row.householdId, epoch), "publication_epoch", `${row.householdId}/${epoch}`);
  assertReplicaWriter(proof.holderHostId === source.sourceHostId);
}

function sealedTicket(tx: ReplicationTx, row: Ticket) {
  return publicationIsSealed(tx, row.householdId, row.publicationEpoch ?? 1)
    && (row.publicationEpoch !== null || tx.select({ kind: conversations.kind }).from(conversations)
      .where(eq(conversations.id, row.conversationId)).get()?.kind === "group");
}

function checkMessage(tx: ReplicationTx, row: Ticket, id: string | null, rev: number | null) {
  if (!id) {
    assertReplicaWriter(rev === null);
    return;
  }
  const original = message(tx, id);
  assertReplicaWriter(original.conversationId === row.conversationId && original.authorMemberId === row.forMemberId
    && rev !== null && original.rev >= rev);
}

function checkChild(tx: ReplicationTx, source: ReplicationSource, row: { originHostId: string; ticketId: string }) {
  const parent = ticket(tx, row.ticketId);
  assertReplicaWriter(row.originHostId === parent.originHostId);
  authorizeTicket(tx, source, parent);
  return parent;
}

function checkTrigger(tx: ReplicationTx, parent: Ticket, id: string) {
  const event = trigger(tx, id);
  assertReplicaWriter(event.receipt.ticket_id === parent.id && event.originHostId === parent.originHostId);
  return event;
}

const ticketReplica = defineReplicationAdapter("ticket", z.strictObject({
  ...businessFields, ...scope,
  publicationEpoch: positive.nullable(),
  kind: z.enum(["followup", "errand"]),
  mandateKind: z.enum(["explicit", "inferred"]),
  sourceMessageId: businessId,
  sourceRevision: positive,
  goal: text,
  status: z.enum(["open", "ended"]),
  stage: z.enum(["scheduled", "queued", "thinking", "waiting", "quiet_waiting", "completed", "failed", "blocked", "discarded", "cancelled"]),
  endedReason: text.nullable(),
  dueAt: millis.nullable(),
  timeZone: text,
}), {
  read: (tx, id) => tx.select().from(tickets).where(eq(tickets.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(tickets)
    .where(and(eq(tickets.householdId, source.householdId), eq(tickets.originHostId, source.sourceHostId)))
    .orderBy(asc(tickets.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(tickets).values(row).onConflictDoUpdate({ target: tickets.id, set: row }).run(); },
  authorize(tx, source, row) {
    authorizeTicket(tx, source, row);
    checkMessage(tx, row, row.sourceMessageId, row.sourceRevision);
  },
  identity: (row) => [row.householdId, row.conversationId, row.forMemberId, row.publisherHostId, row.publicationEpoch,
    row.kind, row.mandateKind, row.sourceMessageId, row.sourceRevision],
  sealed: sealedTicket,
});

const triggerReplica = defineReplicationAdapter("ticket_trigger", z.strictObject({
  ...businessFields, householdId: businessId, conversationId: businessId, actorMemberId: businessId, publisherHostId: businessId,
  source: z.enum(["chat", "app"]), sourceMessageId: businessId.nullable(), sourceRevision: positive.nullable(),
  idempotencyKey: text, commandKind: z.enum(["schedule", "start", "reschedule", "append", "cancel"]),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  receipt: z.strictObject({
    ticket_id: businessId, queued: z.boolean().optional(), when: text.optional(), time_zone: text.optional(),
    saved: z.literal(true).optional(), resumed: z.literal(true).optional(), cancelled: z.literal(true).optional(),
  }),
}), {
  read: (tx, id) => tx.select().from(triggers).where(eq(triggers.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(triggers)
    .where(and(eq(triggers.householdId, source.householdId), eq(triggers.originHostId, source.sourceHostId)))
    .orderBy(asc(triggers.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(triggers).values(row).onConflictDoNothing({ target: triggers.id }).run(); },
  authorize(tx, source, row) {
    const parent = checkChild(tx, source, { ...row, ticketId: row.receipt.ticket_id });
    assertReplicaWriter(row.rev === 1 && row.deletedAt === null && row.householdId === parent.householdId
      && row.conversationId === parent.conversationId && row.actorMemberId === parent.forMemberId
      && row.publisherHostId === parent.publisherHostId);
    checkMessage(tx, parent, row.sourceMessageId, row.sourceRevision);
    const previous = tx.select({ id: triggers.id }).from(triggers).where(and(
      eq(triggers.householdId, row.householdId), eq(triggers.actorMemberId, row.actorMemberId),
      eq(triggers.source, row.source), eq(triggers.idempotencyKey, row.idempotencyKey),
    )).get();
    assertReplicaIdentity(!previous || previous.id === row.id);
  },
  identity: (row) => [row.receipt.ticket_id],
  fact: (row) => [row],
  sealed: (tx, row) => sealedTicket(tx, ticket(tx, row.receipt.ticket_id)),
});

const decisionReplica = defineReplicationAdapter("ticket_decision", z.strictObject({
  ...businessFields, ticketId: businessId, triggerId: businessId, outcome: z.enum(["accept", "attach"]), reasons: z.array(text),
}), {
  read: (tx, id) => tx.select().from(decisions).where(eq(decisions.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select({ row: decisions }).from(decisions)
    .innerJoin(tickets, eq(decisions.ticketId, tickets.id))
    .where(and(eq(tickets.householdId, source.householdId), eq(decisions.originHostId, source.sourceHostId)))
    .orderBy(asc(decisions.id)).limit(limit).all().map(({ row }) => row),
  write: (tx, row) => { tx.insert(decisions).values(row).onConflictDoNothing({ target: decisions.id }).run(); },
  authorize(tx, source, row) {
    checkTrigger(tx, checkChild(tx, source, row), row.triggerId);
    assertReplicaWriter(row.rev === 1 && row.deletedAt === null);
  },
  identity: (row) => [row.ticketId, row.triggerId],
  fact: (row) => [row],
  sealed: (tx, row) => sealedTicket(tx, ticket(tx, row.ticketId)),
});

const inputReplica = defineReplicationAdapter("ticket_input", z.strictObject({
  ...businessFields, ticketId: businessId, triggerId: businessId, memberId: businessId,
  kind: z.enum(["append", "reschedule"]), sourceMessageId: businessId.nullable(), sourceRevision: positive.nullable(), text,
}), {
  read: (tx, id) => tx.select().from(ticketInputs).where(eq(ticketInputs.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select({ row: ticketInputs }).from(ticketInputs)
    .innerJoin(tickets, eq(ticketInputs.ticketId, tickets.id))
    .where(and(eq(tickets.householdId, source.householdId), eq(ticketInputs.originHostId, source.sourceHostId)))
    .orderBy(asc(ticketInputs.id)).limit(limit).all().map(({ row }) => row),
  write: (tx, row) => { tx.insert(ticketInputs).values(row).onConflictDoUpdate({ target: ticketInputs.id, set: row }).run(); },
  authorize(tx, source, row) {
    const parent = checkChild(tx, source, row);
    const event = checkTrigger(tx, parent, row.triggerId);
    assertReplicaWriter(row.memberId === parent.forMemberId && row.kind === event.commandKind
      && row.sourceMessageId === event.sourceMessageId && row.sourceRevision === event.sourceRevision);
    checkMessage(tx, parent, row.sourceMessageId, row.sourceRevision);
  },
  identity: (row) => [row.ticketId, row.triggerId, row.memberId, row.kind, row.sourceMessageId, row.sourceRevision],
  fact: (row) => [row.text],
  sealed: (tx, row) => sealedTicket(tx, ticket(tx, row.ticketId)),
});

const letterReplica = defineReplicationAdapter("mailbox_letter", z.strictObject({
  ...businessFields, ...scope, ticketId: businessId, text, createdHlc: businessFields.hlc,
}), {
  read: (tx, id) => tx.select().from(mailboxLetters).where(eq(mailboxLetters.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(mailboxLetters)
    .where(and(eq(mailboxLetters.householdId, source.householdId), eq(mailboxLetters.originHostId, source.sourceHostId)))
    .orderBy(asc(mailboxLetters.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(mailboxLetters).values(row).onConflictDoUpdate({ target: mailboxLetters.id, set: row }).run(); },
  authorize(tx, source, row) {
    const parent = checkChild(tx, source, row);
    assertReplicaWriter(row.householdId === parent.householdId && row.conversationId === parent.conversationId
      && row.forMemberId === parent.forMemberId && row.publisherHostId === parent.publisherHostId);
  },
  identity: (row) => [row.ticketId, row.householdId, row.conversationId, row.forMemberId, row.publisherHostId, row.createdHlc],
  fact: (row) => [row.text],
  sealed: (tx, row) => sealedTicket(tx, ticket(tx, row.ticketId)),
});

const readReplica = defineReplicationAdapter("mailbox_read", z.strictObject({
  ...businessFields, householdId: businessId, letterId: businessId, memberId: businessId, readAt: millis,
}), {
  read: (tx, id) => tx.select().from(mailboxReads).where(eq(mailboxReads.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(mailboxReads)
    .where(and(eq(mailboxReads.householdId, source.householdId), eq(mailboxReads.originHostId, source.sourceHostId)))
    .orderBy(asc(mailboxReads.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(mailboxReads).values(row).onConflictDoNothing({ target: mailboxReads.id }).run(); },
  authorize(tx, source, row) {
    const original = letter(tx, row.letterId);
    const member = memberInHousehold(tx, row.memberId, source.householdId);
    assertReplicaWriter(row.id === row.letterId && row.householdId === source.householdId
      && row.originHostId === source.sourceHostId && member.homeHostId === source.sourceHostId
      && original.forMemberId === member.id && original.householdId === row.householdId
      && row.rev === 1 && row.deletedAt === null && row.readAt === row.createdAt);
  },
  identity: (row) => [row.letterId, row.householdId, row.memberId],
  fact: (row) => [row],
});

const publicationReplica = defineReplicationAdapter("ticket_publication", z.strictObject({
  ...businessFields, householdId: businessId, ticketId: businessId, ticketRev: positive,
  kind: z.enum(["worker", "inference"]), messageId: businessId.nullable(), letterId: businessId.nullable(),
  audienceDays: z.array(z.strictObject({ memberId: businessId, localDay: z.iso.date() })),
}), {
  read: (tx, id) => tx.select().from(ticketPublications).where(eq(ticketPublications.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(ticketPublications)
    .where(and(eq(ticketPublications.householdId, source.householdId), eq(ticketPublications.originHostId, source.sourceHostId)))
    .orderBy(asc(ticketPublications.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(ticketPublications).values(row).onConflictDoNothing({ target: ticketPublications.id }).run(); },
  authorize(tx, source, row) {
    const parent = checkChild(tx, source, row);
    assertReplicaWriter(parent.householdId === row.householdId && row.rev === 1 && row.deletedAt === null
      && (row.messageId || row.letterId) && (row.kind === "inference") === (parent.mandateKind === "inferred")
      && (row.kind === "inference" || row.audienceDays.length === 0));
    if (parent.rev < row.ticketRev) {
      requireReplicaDependency(undefined, "ticket_revision", parent.id);
    }
    if (row.messageId) {
      const published = message(tx, row.messageId);
      assertReplicaWriter(published.originHostId === source.sourceHostId && published.authorMemberId === null
        && published.conversationId === parent.conversationId && published.replyToMessageId === parent.sourceMessageId
        && published.publicationEpoch === parent.publicationEpoch);
    }
    if (row.letterId) assertReplicaWriter(letter(tx, row.letterId).ticketId === parent.id);
    for (const day of row.audienceDays) memberInHousehold(tx, day.memberId, row.householdId);
  },
  identity: (row) => [row.ticketId, row.ticketRev, row.kind],
  fact: (row) => [row],
  sealed: (tx, row) => sealedTicket(tx, ticket(tx, row.ticketId)),
});

export const ticketReplicaAdapters = {
  ticket: ticketReplica, ticket_trigger: triggerReplica, ticket_decision: decisionReplica, ticket_input: inputReplica,
  mailbox_letter: letterReplica, mailbox_read: readReplica, ticket_publication: publicationReplica,
};

// Both holders hash the persisted business projection, in the same field and row order.
export function groupTicketHistory(tx: ReplicationTx, conversationId: string, epoch: number) {
  const filter = and(eq(tickets.conversationId, conversationId), sql`coalesce(${tickets.publicationEpoch}, 1) = ${epoch}`);
  const ids = tx.select({ id: tickets.id }).from(tickets).where(filter);
  const records = [
    ...tx.select().from(tickets).where(filter).orderBy(asc(tickets.id)).all().map((row) => ticketReplica.decode(row)),
    ...tx.select().from(triggers).where(inArray(sql`json_extract(${triggers.receipt}, '$.ticket_id')`, ids))
      .orderBy(asc(triggers.id)).all().map((row) => triggerReplica.decode(row)),
    ...tx.select().from(decisions).where(inArray(decisions.ticketId, ids))
      .orderBy(asc(decisions.id)).all().map((row) => decisionReplica.decode(row)),
    ...tx.select().from(ticketInputs).where(inArray(ticketInputs.ticketId, ids))
      .orderBy(asc(ticketInputs.id)).all().map((row) => inputReplica.decode(row)),
    ...tx.select().from(mailboxLetters).where(inArray(mailboxLetters.ticketId, ids))
      .orderBy(asc(mailboxLetters.id)).all().map(({ readAt: _localLegacyRead, ...row }) => letterReplica.decode(row)),
    ...tx.select().from(ticketPublications).where(inArray(ticketPublications.ticketId, ids))
      .orderBy(asc(ticketPublications.id)).all().map((row) => publicationReplica.decode(row)),
  ];
  return records;
}
