import { and, eq, exists, gt, inArray, isNotNull, isNull, not, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { hasValidExtractionDependencies } from "./extraction-evidence.ts";
import type { StoreDb } from "./index.ts";
import { matchingMemoryBlocks, matchingNewerCorrections } from "./knowledge.ts";
import { readKnowledgeEvidenceText, readReplyKnowledge } from "./knowledge-use.ts";
import { messages } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";
import { knowledgeSourceWithdrawals, memories } from "./schema/knowledge.ts";

/** 只读取当前可以用于模型的原话及回复。 */
export function listModelVisibleMessages(
  db: Pick<StoreDb, "select">,
  householdId: string,
  conversationId: string,
  messageIds: readonly string[],
) {
  if (!messageIds.length) { return []; }
  const parent = alias(messages, "reply_source");
  const withdrawn = db.select({ id: knowledgeSourceWithdrawals.id }).from(knowledgeSourceWithdrawals)
    .where(and(
      eq(knowledgeSourceWithdrawals.householdId, householdId),
      or(eq(knowledgeSourceWithdrawals.sourceMessageId, messages.id),
        eq(knowledgeSourceWithdrawals.sourceMessageId, messages.replyToMessageId)),
    ));
  const suppressedMemory = db.select({ id: memories.id }).from(memories).where(and(
    eq(memories.householdId, householdId),
    or(isNotNull(memories.deletedAt), gt(memories.rev, 1), exists(matchingMemoryBlocks(db, memories)),
      exists(matchingNewerCorrections(db)),
      not(hasValidExtractionDependencies(db, memories.id))),
    or(eq(memories.sourceMessageId, messages.id), eq(memories.sourceMessageId, messages.replyToMessageId)),
  ));
  const invalidReplySource = db.select({ id: parent.id }).from(parent).where(and(
    eq(parent.id, messages.replyToMessageId),
    or(isNotNull(parent.deletedAt), gt(parent.rev, 1)),
  ));
  const activeAuthor = db.select({ id: members.id }).from(members).where(and(
    eq(members.id, messages.authorMemberId),
    eq(members.householdId, householdId),
    isNull(members.deletedAt),
  ));
  const rows = db.select().from(messages).where(and(
    eq(messages.conversationId, conversationId),
    inArray(messages.id, messageIds),
    isNull(messages.deletedAt),
    eq(messages.historyContextBlocked, false),
    or(isNull(messages.authorMemberId), exists(activeAuthor)),
    notExists(withdrawn),
    notExists(suppressedMemory),
    notExists(invalidReplySource),
  )).all();
  const replyEvidence = readReplyKnowledge(db, rows.filter(({ authorMemberId }) => authorMemberId === null).map(({ id }) => id));
  return rows.flatMap((row) => {
    const evidence = replyEvidence.get(row.id) ?? [];
    return evidence.every((item) => readKnowledgeEvidenceText(db, householdId, item) !== undefined)
      ? [{ ...row, knowledgeEvidence: evidence }] : [];
  });
}
