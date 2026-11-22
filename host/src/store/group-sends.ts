import { and, eq } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { businessRow } from "./business.ts";
import type { MemberMessageInput } from "./conversations.ts";
import type { StoreDb } from "./index.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { appendNativeChange } from "./replication.ts";
import { replicaAdapters } from "./replica-records.ts";
import { conversations, groupSendIntents, members, participants } from "./schema/index.ts";

type Reader = Pick<StoreDb, "select">;
export type GroupSendIntent = typeof groupSendIntents.$inferSelect;
type SendScope = Pick<GroupSendIntent, "householdId" | "conversationId" | "memberId" | "originHostId">;

export function groupSenderState(db: Reader, scope: SendScope) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, scope.conversationId)).get();
  const member = db.select().from(members).where(eq(members.id, scope.memberId)).get();
  if ((conversation && (conversation.householdId !== scope.householdId || conversation.kind !== "group"
    || conversation.deletedAt !== null)) || (member && (member.householdId !== scope.householdId
    || member.homeHostId !== scope.originHostId || member.deletedAt !== null))) {
    return "rejected";
  }
  const participant = db.select().from(participants).where(and(
    eq(participants.conversationId, scope.conversationId), eq(participants.memberId, scope.memberId),
  )).get();
  if (participant?.deletedAt != null) return "rejected";
  return conversation && member && participant ? "ready" : "waiting";
}

export function getGroupSend(db: Reader, id: string) {
  return db.select().from(groupSendIntents).where(eq(groupSendIntents.id, id)).get();
}

export function findGroupSend(db: Reader, input: Omit<MemberMessageInput, "text">) {
  return db.select().from(groupSendIntents).where(and(
    eq(groupSendIntents.conversationId, input.conversationId), eq(groupSendIntents.memberId, input.memberId),
    eq(groupSendIntents.clientMessageId, input.clientMessageId),
  )).get();
}

export function insertGroupSend(tx: ReplicationTx, clock: Clock, hostId: string, householdId: string, input: MemberMessageInput) {
  const row = tx.insert(groupSendIntents).values({
    ...businessRow(clock, hostId), ...input, householdId, status: "pending",
  }).returning().get()!;
  appendNativeChange(tx, hostId, householdId, replicaAdapters.group_send_intent, row);
  return row;
}

export function updateGroupSend(
  tx: ReplicationTx, id: string, change: Pick<Partial<GroupSendIntent>, "status" | "deliveryId">,
) {
  tx.update(groupSendIntents).set(change).where(eq(groupSendIntents.id, id)).run();
}

export function pendingGroupSends(db: Reader, hostId: string, householdId: string) {
  return db.select().from(groupSendIntents).where(and(
    eq(groupSendIntents.originHostId, hostId), eq(groupSendIntents.householdId, householdId),
    eq(groupSendIntents.status, "pending"),
  )).all();
}
