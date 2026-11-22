import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { businessFields, businessId } from "../replication/types.ts";
import { dayStart, localDay, nextDay } from "../soul/diary-date.ts";
import { catFactKey, catFactSchema } from "../soul/facts.ts";
import type { CatFact, DiarySource } from "../soul/facts.ts";
import { publicationIsSealed } from "./publication.ts";
import { assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter, requireReplicaDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { memberInHousehold } from "./replica-scope.ts";
import { catFacts } from "./schema/cat-facts.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { diaryEntries } from "./schema/diary.ts";
import { authorizeCat } from "./world-replicas.ts";

export type CatFactRow = Omit<typeof catFacts.$inferSelect, "fact" | "deletedAt"> & { fact: CatFact; deletedAt: null };

function verifySource(tx: ReplicationTx, householdId: string, memberId: string, source: DiarySource) {
  memberInHousehold(tx, memberId, householdId);
  if (source.kind === "diary") {
    const diary = requireReplicaDependency(tx.select().from(diaryEntries).where(eq(diaryEntries.id, source.id)).get(),
      "diary_entry", source.id);
    assertReplicaWriter(diary.householdId === householdId && diary.ownerMemberId === memberId);
    if (diary.rev < source.rev) requireReplicaDependency(undefined, "diary_entry", source.id);
    return;
  }
  const message = requireReplicaDependency(tx.select({ msg: messages, householdId: conversations.householdId })
    .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, source.sourceMessageId)).get(), "message", source.sourceMessageId);
  assertReplicaWriter(source.sourceMemberId === memberId && message.householdId === householdId
    && message.msg.authorMemberId === memberId);
  if (message.msg.rev < source.sourceRevision) requireReplicaDependency(undefined, "message", source.sourceMessageId);
}

function relatedFact(tx: ReplicationTx, row: CatFactRow, id: string) {
  const source = requireReplicaDependency(tx.select().from(catFacts).where(eq(catFacts.id, id)).get() as CatFactRow | undefined,
    "cat_fact", id);
  assertReplicaWriter(row.catId === source.catId && source.epoch <= row.epoch);
  return source.fact;
}

export const catFactReplica = defineReplicationAdapter("cat_fact", z.strictObject({
  ...businessFields, deletedAt: z.null(), householdId: businessId, catId: businessId,
  epoch: z.int().positive(), grantId: z.uuid(), key: z.string().min(1).max(150), kind: z.string(), fact: catFactSchema,
}), {
  read: (tx, id) => tx.select().from(catFacts).where(eq(catFacts.id, id)).get() as CatFactRow | undefined,
  snapshotRows: (tx, source, limit) => tx.select().from(catFacts).where(and(
    eq(catFacts.originHostId, source.sourceHostId), eq(catFacts.householdId, source.householdId),
  )).orderBy(asc(catFacts.id)).limit(limit).all() as CatFactRow[],
  write: (tx, row) => { tx.insert(catFacts).values(row).run(); },
  authorize(tx, source, row) {
    authorizeCat(tx, source, row);
    const { fact, catId, householdId } = row;
    assertReplicaIdentity(row.rev === 1 && row.kind === fact.type && row.key === catFactKey(fact));
    const kinds = fact.type === "soul_edit" || fact.type === "soul_withdrawal"
      ? ["soul_edit", "soul_withdrawal"] : [fact.type];
    for (const kind of kinds) {
      const existing = tx.select({ id: catFacts.id }).from(catFacts).where(and(
        eq(catFacts.catId, catId), eq(catFacts.kind, kind), eq(catFacts.key, row.key),
      )).get();
      assertReplicaIdentity(!existing || existing.id === row.id);
    }
    if (fact.type === "soul_edit") verifySource(tx, householdId, fact.source.sourceMemberId, fact.source);
    if (fact.type === "legacy_soul") {
      for (const entry of [...fact.entries, ...(fact.state ? [fact.state] : [])]) {
        verifySource(tx, householdId, entry.source.sourceMemberId, entry.source);
      }
    }
    if (fact.type === "soul_withdrawal") {
      const edit = relatedFact(tx, row, fact.entryId);
      assertReplicaWriter(edit.type === "soul_edit" && edit.source.sourceMemberId === fact.memberId && edit.version < fact.version);
    }
    if (fact.type === "diary_source") verifySource(tx, householdId, fact.memberId, fact.source);
    if (fact.type === "diary_observation") {
      assertReplicaIdentity(fact.day === localDay(fact.observedAt, fact.timeZone));
    }
    if (fact.type === "diary_plan") {
      assertReplicaIdentity(fact.startAt === dayStart(fact.day, fact.timeZone)
        && fact.endAt === dayStart(nextDay(fact.day), fact.timeZone) && fact.endAt > fact.startAt);
    }
    if (fact.type === "daily_diary") {
      const plan = relatedFact(tx, row, fact.planId);
      assertReplicaIdentity(plan.type === "diary_plan" && plan.day === fact.day);
      assertReplicaIdentity(new Set(fact.cards.map(({ id }) => id)).size === fact.cards.length);
      assertReplicaIdentity(new Set(fact.inputs.map(({ id }) => id)).size === fact.inputs.length
        && fact.cards.every(({ id, sha256 }) => fact.inputs.some((input) => input.id === id && input.sha256 === sha256)));
      for (const card of fact.inputs) {
        const dependency = relatedFact(tx, row, card.id);
        assertReplicaIdentity(dependency.type === "diary_source"
          || (dependency.type === "diary_observation" && dependency.day === fact.day));
      }
    }
  },
  identity: (row) => [row.householdId, row.catId, row.epoch, row.grantId, row.kind, row.key, row.fact, row.hlc, row.updatedAt],
  sealed: (tx, row) => publicationIsSealed(tx, row.householdId, row.epoch),
});

export function catFactPublicationHistory(tx: ReplicationTx, householdId: string, epoch: number) {
  return tx.select().from(catFacts).where(and(eq(catFacts.householdId, householdId), eq(catFacts.epoch, epoch)))
    .orderBy(asc(catFacts.id)).all().map(({ fact, ...row }) => ["cat_fact", { ...row, fact: catFactSchema.parse(fact) }]);
}
