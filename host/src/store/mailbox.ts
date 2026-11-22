import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow } from "./business.ts";
import { getHostMeta } from "./host-meta.ts";
import { getMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { conversations, participants } from "./schema/conversations.ts";
import { appendNativeChange } from "./replication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { mailboxLetters, mailboxReads } from "./schema/publications.ts";

type Letter = typeof mailboxLetters.$inferSelect;
type Reader = Pick<StoreDb, "select">;

export class MailboxError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string) {
    super(code);
  }
}

function letterView(row: Letter, readAt: number | null) {
  return {
    id: row.id, conversation_id: row.conversationId, for_member_id: row.forMemberId,
    publisher_host_id: row.publisherHostId, ticket_id: row.ticketId, text: row.text,
    created_at: row.createdAt, read_at: readAt,
  };
}

function memberLetters(db: Reader, actor: Actor) {
  const visible = db.select({ id: conversations.id }).from(conversations)
    .innerJoin(participants, eq(participants.conversationId, conversations.id))
    .where(and(
      eq(conversations.householdId, actor.householdId), isNull(conversations.deletedAt),
      eq(participants.memberId, actor.memberId), isNull(participants.deletedAt),
      or(eq(conversations.kind, "group"), eq(conversations.ownerMemberId, actor.memberId)),
    ));
  return and(
    eq(mailboxLetters.householdId, actor.householdId),
    eq(mailboxLetters.forMemberId, actor.memberId),
    inArray(mailboxLetters.conversationId, visible),
  );
}

function visibleLetterRows(db: Reader, actor: Actor, after?: ReturnType<typeof and>) {
  return db.select({ letter: mailboxLetters, readAt: mailboxReads.readAt }).from(mailboxLetters)
    .leftJoin(mailboxReads, eq(mailboxReads.letterId, mailboxLetters.id))
    .where(and(memberLetters(db, actor), isNull(mailboxLetters.deletedAt), after))
    .orderBy(asc(mailboxLetters.createdHlc), asc(mailboxLetters.id));
}

export function readActorMailbox(db: Reader, actor: Actor) {
  return visibleLetterRows(db, actor).all()
    .map(({ letter, readAt }) => ({ ...letterView(letter, readAt), revision: letter.rev }));
}

export function listMailbox(
  db: Pick<StoreDb, "transaction">, actor: Actor, input: { after?: string; limit: number },
) {
  return db.transaction((tx) => {
    const visibility = memberLetters(tx, actor);
    const cursor = input.after ? tx.select().from(mailboxLetters)
      .where(and(eq(mailboxLetters.id, input.after), visibility)).get() : undefined;
    if (input.after && !cursor) {
      throw new MailboxError(400, "invalid_cursor");
    }
    const after = cursor ? or(gt(mailboxLetters.createdHlc, cursor.createdHlc),
      and(eq(mailboxLetters.createdHlc, cursor.createdHlc), gt(mailboxLetters.id, cursor.id))) : undefined;
    const rows = visibleLetterRows(tx, actor, after).limit(input.limit + 1).all();
    const page = rows.slice(0, input.limit);
    return {
      letters: page.map(({ letter, readAt }) => letterView(letter, readAt)),
      next_cursor: page.at(-1)?.letter.id ?? input.after ?? null,
      has_more: rows.length > input.limit,
    };
  });
}

export function markLetterRead(db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor, id: string) {
  return db.transaction((tx) => {
    const row = tx.select().from(mailboxLetters).where(and(
      eq(mailboxLetters.id, id), isNull(mailboxLetters.deletedAt), memberLetters(tx, actor),
    )).get();
    if (!row) {
      throw new MailboxError(404, "not_found");
    }
    const read = tx.select().from(mailboxReads).where(eq(mailboxReads.letterId, id)).get();
    if (read) return letterView(row, read.readAt);
    const member = getMember(tx, actor.memberId);
    if (!member || member.homeHostId !== getHostMeta(tx, "host_id")) {
      throw new MailboxError(409, "not_publisher");
    }
    const change = businessRow(clock, member.homeHostId);
    const acknowledgement = tx.insert(mailboxReads).values({
      ...change, id, letterId: id, householdId: actor.householdId, memberId: member.id, readAt: change.createdAt,
    }).returning().get()!;
    appendNativeChange(tx, member.homeHostId, actor.householdId, replicaAdapters.mailbox_read, acknowledgement);
    return letterView(row, acknowledgement.readAt);
  }, { behavior: "immediate" });
}
