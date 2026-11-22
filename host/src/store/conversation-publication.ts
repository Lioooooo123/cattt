import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { ConversationHead } from "../ticket-workers/types.ts";
import { businessRow } from "./business.ts";
import { appendCatMessage } from "./conversations.ts";
import type { StoreDb } from "./index.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { appendNativeChange } from "./replication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { mailboxLetters, ticketPublications } from "./schema/publications.ts";
import { turns } from "./schema/turns.ts";

type Reader = Pick<StoreDb, "select">;

export function conversationHead(db: Reader, conversationId: string): ConversationHead {
  const conversation = db.select({ revision: conversations.rev }).from(conversations)
    .where(eq(conversations.id, conversationId)).get()!;
  const latestMessage = db.select({ id: messages.id, revision: messages.rev }).from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.hlc), desc(messages.id)).limit(1).get() ?? null;
  return { ...conversation, latestMessage };
}

export function freshConversation(
  db: Reader, conversation: Pick<typeof conversations.$inferSelect, "id" | "rev">, head: ConversationHead,
): boolean {
  const anchor = head.latestMessage && db.select().from(messages).where(and(
    eq(messages.id, head.latestMessage.id), eq(messages.conversationId, conversation.id),
    eq(messages.rev, head.latestMessage.revision), isNull(messages.deletedAt),
  )).get();
  if (head.latestMessage && !anchor) {
    return false;
  }
  const later = anchor ? or(gt(messages.hlc, anchor.hlc), and(eq(messages.hlc, anchor.hlc), gt(messages.id, anchor.id))) : undefined;
  const scope = and(eq(messages.conversationId, conversation.id), isNull(messages.deletedAt), later);
  if (db.select({ id: messages.id }).from(messages)
    .where(and(scope, isNotNull(messages.authorMemberId))).limit(1).get()) {
    return false;
  }
  // 普通轮次的猫回复也增加会话修订。新成员发言和无法解释的差值使旧研判失效。
  const { total } = db.select({ total: count() }).from(messages).where(scope).get()!;
  return conversation.rev === head.revision + total;
}

export function activeConversation(db: Reader, id: string): boolean {
  return db.select({ id: turns.id }).from(turns).where(and(
    eq(turns.conversationId, id), inArray(turns.status, ["queued", "generating"]),
  )).limit(1).get() !== undefined;
}

/** Router 复核后在同一事务写入可见内容和对应收据。 */
export function writePublicationDelivery(
  db: ReplicationTx, clock: Clock,
  scope: { hostId: string; householdId: string; conversationId: string; forMemberId: string; ticketId: string; sourceMessageId: string },
  delivery: { chat?: string; letter?: string },
  proof: { epoch: number | null; ticketRev: number; kind: "worker" | "inference"; audienceDays?: { memberId: string; localDay: string }[] },
) {
  const { hostId, householdId, conversationId, forMemberId, ticketId, sourceMessageId } = scope;
  const messageId = delivery.chat ? appendCatMessage(db, clock, {
    hostId, conversationId, text: delivery.chat,
    replyToMessageId: sourceMessageId, turnId: null, status: "complete", publicationEpoch: proof.epoch,
  }).id : null;
  let letterId: string | null = null;
  if (delivery.letter) {
    const row = businessRow(clock, hostId);
    const letter = db.insert(mailboxLetters).values({
      ...row, createdHlc: row.hlc, householdId, conversationId, forMemberId,
      publisherHostId: hostId, ticketId, text: delivery.letter,
    }).returning().get()!;
    appendNativeChange(db, hostId, householdId, replicaAdapters.mailbox_letter, letter);
    letterId = letter.id;
  }
  if (messageId || letterId) {
    const published = db.insert(ticketPublications).values({
      ...businessRow(clock, hostId), householdId, ticketId, ticketRev: proof.ticketRev,
      kind: proof.kind, messageId, letterId, audienceDays: proof.audienceDays ?? [],
    }).returning().get()!;
    appendNativeChange(db, hostId, householdId, replicaAdapters.ticket_publication, published);
  }
  return { messageId, letterId };
}
