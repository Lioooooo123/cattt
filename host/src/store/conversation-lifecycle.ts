import { and, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { businessRow, revision } from "./business.ts";
import type { StoreDb } from "./index.ts";
import { conversations, participants } from "./schema/conversations.ts";
import { households, members } from "./schema/identity.ts";

export function ensureGroup(
  db: Pick<StoreDb, "select" | "insert">, clock: Clock, hostId: string, householdId: string,
) {
  const existing = db.select().from(conversations).where(and(
    eq(conversations.householdId, householdId), eq(conversations.kind, "group"),
  )).get();
  if (existing) {
    return existing;
  }
  return db.insert(conversations).values({
    ...businessRow(clock, hostId), householdId, kind: "group", ownerMemberId: null, publisherHostId: hostId,
  }).returning().get()!;
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
      eq(members.householdId, householdId), isNull(members.deletedAt),
    )).all();
    const activeIds = new Set(active.map((member) => member.id));
    for (const member of active) {
      const direct = tx.select().from(conversations).where(and(
        eq(conversations.kind, "direct"), eq(conversations.ownerMemberId, member.id),
      )).get();
      if (!direct) {
        tx.insert(conversations).values({
          ...businessRow(clock, hostId), householdId, kind: "direct",
          ownerMemberId: member.id, publisherHostId: member.homeHostId,
        }).run();
      } else if (direct.deletedAt === null && direct.publisherHostId !== member.homeHostId) {
        tx.update(conversations).set({
          ...revision(clock), publisherHostId: member.homeHostId, rev: sql`${conversations.rev} + 1`,
        }).where(eq(conversations.id, direct.id)).run();
      }
    }
    const rows = tx.select().from(conversations).where(and(
      eq(conversations.householdId, householdId), isNull(conversations.deletedAt),
    )).all();
    for (const conversation of rows) {
      const desired = conversation.kind === "group" ? activeIds
        : new Set(conversation.ownerMemberId && activeIds.has(conversation.ownerMemberId) ? [conversation.ownerMemberId] : []);
      const previous = tx.select().from(participants).where(eq(participants.conversationId, conversation.id)).all();
      for (const memberId of desired) {
        const row = previous.find((participant) => participant.memberId === memberId);
        if (!row) {
          tx.insert(participants).values({
            ...businessRow(clock, hostId), conversationId: conversation.id, memberId,
          }).run();
        } else if (row.deletedAt !== null) {
          tx.update(participants).set({ ...revision(clock), deletedAt: null, rev: sql`${participants.rev} + 1` })
            .where(eq(participants.id, row.id)).run();
        }
      }
      for (const row of previous) {
        if (row.deletedAt === null && !desired.has(row.memberId)) {
          const update = revision(clock);
          tx.update(participants).set({ ...update, deletedAt: update.updatedAt, rev: sql`${participants.rev} + 1` })
            .where(eq(participants.id, row.id)).run();
        }
      }
    }
  }, { behavior: "immediate" });
}
