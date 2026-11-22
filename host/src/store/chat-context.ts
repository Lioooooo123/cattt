import type { Message } from "../conversations/types.ts";
import { ConversationNotFoundError, getConversation, messageDto } from "./conversations.ts";
import { requireLocalHostId } from "./host-meta.ts";
import { getHousehold, getMember, listMembers } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import type { RecallEvidence } from "./knowledge-use.ts";
import { listModelVisibleMessages } from "./model-visible-messages.ts";

export function readChatScope(db: Pick<StoreDb, "select" | "transaction">, trigger: Message) {
  const member = trigger.author.kind === "member" ? getMember(db, trigger.author.member_id) : undefined;
  if (!member || !getHousehold(db, member.householdId)) {
    throw new ConversationNotFoundError();
  }
  const { id: memberId, householdId } = member;
  const conversation = getConversation(db, {
    memberId, householdId, hostId: requireLocalHostId(db), deviceId: "runner",
  }, trigger.conversation_id);
  return { conversation, householdId, members: listMembers(db, householdId) };
}

/** 使用本地最新记录校验 runner 的窗口，消息展示仍走原历史仓储。 */
export function readChatModelHistory(
  db: Pick<StoreDb, "select">,
  householdId: string,
  conversationId: string,
  trigger: Message,
  history: readonly Message[],
) {
  const rows = listModelVisibleMessages(db, householdId, conversationId, [...new Set([...history.map(({ id }) => id), trigger.id])]);
  const current = new Map(rows.map((row) => [row.id, messageDto(row)]));
  const liveTrigger = current.get(trigger.id);
  if (!liveTrigger || liveTrigger.status !== "complete" || liveTrigger.cursor !== trigger.cursor || liveTrigger.author.kind !== "member"
    || trigger.author.kind !== "member" || liveTrigger.author.member_id !== trigger.author.member_id) {
    throw new ConversationNotFoundError();
  }
  const liveHistory = history.flatMap((snapshot) => {
    const row = current.get(snapshot.id);
    return row && row.id !== liveTrigger.id && row.cursor === snapshot.cursor ? [row] : [];
  });
  const memberSources = new Map<string, Extract<RecallEvidence, { kind: "message" }>>();
  for (const row of rows) {
    if (row.authorMemberId && row.status === "complete") {
      memberSources.set(row.id, {
        kind: "message", sourceMemberId: row.authorMemberId, sourceMessageId: row.id, sourceRevision: row.rev,
      });
    }
  }
  return { trigger: liveTrigger, history: liveHistory, memberSources,
    evidenceByMessage: new Map(rows.map(({ id, knowledgeEvidence }) => [id, knowledgeEvidence])) };
}
