import { and, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { businessRow, revision } from "./business.ts";
import type { StoreDb } from "./index.ts";
import { appendNativeChange } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { replicaAdapters } from "./replica-records.ts";
import { conversations, participants } from "./schema/conversations.ts";
import { households, members } from "./schema/identity.ts";

export function ensureGroup(tx: ReplicationTx, clock: Clock, hostId: string, householdId: string) {
  const existing = findGroup(tx, householdId);
  if (existing) {
    return existing;
  }
  const household = tx.select().from(households).where(eq(households.id, householdId)).get();
  if (household?.originHostId !== hostId || household.deletedAt !== null) {
    return undefined;
  }
  const group = tx.insert(conversations).values({
    ...businessRow(clock, hostId), householdId, kind: "group", ownerMemberId: null, publisherHostId: hostId,
  }).returning().get()!;
  appendNativeChange(tx, hostId, householdId, replicaAdapters.conversation, group);
  return group;
}

export function findGroup(db: Pick<StoreDb, "select">, householdId: string) {
  return db.select().from(conversations).where(and(
    eq(conversations.householdId, householdId), eq(conversations.kind, "group"),
  )).get();
}

export function reconcileConversations(
  db: Pick<StoreDb, "transaction">, clock: Clock, hostId: string, householdId: string,
): void {
  db.transaction((tx) => {
    const household = tx.select().from(households).where(and(
      eq(households.id, householdId), isNull(households.deletedAt),
    )).get();
    if (!household) {
      return;
    }
    ensureGroup(tx, clock, hostId, householdId);
    const active = tx.select().from(members).where(and(
      eq(members.householdId, householdId), eq(members.originHostId, hostId), isNull(members.deletedAt),
    )).all();
    const activeIds = new Set(active.map((member) => member.id));
    for (const member of active) {
      const direct = tx.select().from(conversations).where(and(
        eq(conversations.kind, "direct"), eq(conversations.ownerMemberId, member.id),
      )).get();
      if (!direct) {
        const created = tx.insert(conversations).values({
          ...businessRow(clock, hostId), householdId, kind: "direct",
          ownerMemberId: member.id, publisherHostId: member.homeHostId,
        }).returning().get()!;
        appendNativeChange(tx, hostId, householdId, replicaAdapters.conversation, created);
      } else if (direct.deletedAt === null && direct.publisherHostId !== member.homeHostId) {
        const updated = tx.update(conversations).set({
          ...revision(clock), publisherHostId: member.homeHostId, rev: sql`${conversations.rev} + 1`,
        }).where(eq(conversations.id, direct.id)).returning().get()!;
        appendNativeChange(tx, hostId, householdId, replicaAdapters.conversation, updated);
      }
    }
    const rows = tx.select().from(conversations).where(and(
      eq(conversations.householdId, householdId), isNull(conversations.deletedAt),
    )).all();
    for (const conversation of rows) {
      const desired = conversation.kind === "group" ? activeIds
        : new Set(conversation.ownerMemberId && activeIds.has(conversation.ownerMemberId) ? [conversation.ownerMemberId] : []);
      const previous = tx.select().from(participants).where(and(
        eq(participants.conversationId, conversation.id), eq(participants.originHostId, hostId),
      )).all();
      const previousIds = new Set(previous.map((row) => row.memberId));
      for (const memberId of desired) {
        if (!previousIds.has(memberId)) {
          const created = tx.insert(participants).values({
            ...businessRow(clock, hostId), conversationId: conversation.id, memberId,
          }).returning().get()!;
          appendNativeChange(tx, hostId, householdId, replicaAdapters.participant, created);
        }
      }
      for (const row of previous) {
        if (row.deletedAt === null && !desired.has(row.memberId)) {
          const update = revision(clock);
          const removed = tx.update(participants).set({
            ...update, deletedAt: update.updatedAt, rev: sql`${participants.rev} + 1`,
          }).where(eq(participants.id, row.id)).returning().get()!;
          appendNativeChange(tx, hostId, householdId, replicaAdapters.participant, removed);
        }
      }
    }
  }, { behavior: "immediate" });
}
