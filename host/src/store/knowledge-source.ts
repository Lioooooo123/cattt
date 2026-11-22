import { and, eq, exists, isNull, notExists } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow } from "./business.ts";
import { requireLocalHostId } from "./host-meta.ts";
import { getHouseholdMember } from "./identity.ts";
import { replicaAdapters } from "./replica-records.ts";
import { appendNativeChange } from "./replication.ts";
import type { StoreDb } from "./index.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { households, members } from "./schema/identity.ts";
import { knowledgeSourceWithdrawals } from "./schema/knowledge.ts";

export interface KnowledgeSource {
  householdId: string;
  sourceMemberId: string;
  sourceMessageId: string;
  sourceRevision: number;
}

type Reader = Pick<StoreDb, "select">;
type SourceColumns = { [K in keyof KnowledgeSource]: KnowledgeSource[K] | SQLWrapper };

function sourceQuery(db: Reader, source: SourceColumns, requireAllowed: boolean) {
  return db.select({ message: messages }).from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(households, eq(households.id, conversations.householdId))
    .innerJoin(members, eq(members.id, messages.authorMemberId))
    .where(and(
      eq(messages.id, source.sourceMessageId),
      eq(messages.rev, source.sourceRevision),
      eq(members.id, source.sourceMemberId),
      eq(conversations.householdId, source.householdId),
      eq(members.householdId, conversations.householdId),
      isNull(messages.deletedAt),
      eq(messages.status, "complete"),
      isNull(conversations.deletedAt),
      isNull(members.deletedAt),
      isNull(households.deletedAt),
      requireAllowed ? eq(messages.historyContextBlocked, false) : undefined,
      requireAllowed ? notExists(db.select({ id: knowledgeSourceWithdrawals.id })
        .from(knowledgeSourceWithdrawals).where(eq(knowledgeSourceWithdrawals.sourceMessageId, messages.id))) : undefined,
    ));
}

export function hasKnowledgeSource(db: Reader, source: SourceColumns) {
  return exists(sourceQuery(db, source, true));
}

/** 可信业务调用，按事实的归属核对来源。设备聊天展示仍走会话授权。 */
export function readKnowledgeSource(db: Reader, source: KnowledgeSource) {
  return sourceQuery(db, source, true).get()?.message;
}

/** 停用原话的知识用途，保留原话及其历史排序。 */
export function withdrawKnowledgeSource(
  db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor,
  messageId: string, expectedRevision: number,
) {
  return db.transaction((tx) => {
    const source = {
      householdId: actor.householdId,
      sourceMemberId: actor.memberId,
      sourceMessageId: messageId,
      sourceRevision: expectedRevision,
    };
    const hostId = requireLocalHostId(tx);
    if (getHouseholdMember(tx, actor.householdId, actor.memberId)?.homeHostId !== hostId
      || !sourceQuery(tx, source, false).get()) {
      return undefined;
    }
    const existing = tx.select().from(knowledgeSourceWithdrawals)
      .where(eq(knowledgeSourceWithdrawals.sourceMessageId, messageId)).get();
    if (existing) {
      return existing;
    }
    const row = tx.insert(knowledgeSourceWithdrawals).values({
      ...businessRow(clock, hostId), ...source,
    }).returning().get()!;
    appendNativeChange(tx, hostId, row.householdId, replicaAdapters.knowledge_source_withdrawal, row);
    return row;
  }, { behavior: "immediate" });
}
