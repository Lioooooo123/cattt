import { and, eq, exists, gt, isNotNull, isNull, notExists, or } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { StoreDb } from "./index.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";
import { knowledgeSourceWithdrawals } from "./schema/knowledge.ts";
import { chatReplyKnowledge, memoryExtractionDependencies } from "./schema/memory-extraction.ts";

type Reader = Pick<StoreDb, "select">;

/** 与原话、主语和边界检查一起用于有效召回及发布复核。 */
export function hasValidExtractionDependencies(db: Reader, memoryId: string | SQLWrapper) {
  const dependency = memoryExtractionDependencies;
  const parent = alias(messages, "extraction_question_source");
  const allowed = db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.id, dependency.contextMessageId),
    exists(db.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.id, messages.conversationId), isNull(conversations.deletedAt),
    ))),
    eq(messages.rev, dependency.contextRevision),
    eq(messages.status, "complete"),
    isNull(messages.deletedAt),
    eq(messages.historyContextBlocked, false),
    notExists(db.select({ id: chatReplyKnowledge.messageId }).from(chatReplyKnowledge)
      .where(eq(chatReplyKnowledge.messageId, messages.id))),
    or(isNull(messages.authorMemberId), exists(db.select({ id: members.id }).from(members).where(and(
      eq(members.id, messages.authorMemberId),
      isNull(members.deletedAt),
    )))),
    notExists(db.select({ id: knowledgeSourceWithdrawals.id }).from(knowledgeSourceWithdrawals)
      .where(or(eq(knowledgeSourceWithdrawals.sourceMessageId, messages.id),
        eq(knowledgeSourceWithdrawals.sourceMessageId, messages.replyToMessageId)))),
    notExists(db.select({ id: parent.id }).from(parent).where(and(
      eq(parent.id, messages.replyToMessageId), or(isNotNull(parent.deletedAt), gt(parent.rev, 1)),
    ))),
  ));
  return notExists(db.select({ id: dependency.memoryId }).from(dependency).where(and(
    eq(dependency.memoryId, memoryId),
    notExists(allowed),
  )));
}
