import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { businessFields, businessId, ReplicationError } from "../replication/types.ts";
import type { ReplicatedRevision, ReplicationSource } from "../replication/types.ts";
import { matchesDiaryLocalDay } from "./diary-date.ts";
import { hostInHousehold, memberInHousehold, messageInHousehold } from "./replica-scope.ts";
import { assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter, requireReplicaDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import type { messages } from "./schema/conversations.ts";
import { diaryEntries } from "./schema/diary.ts";
import { boundaries, knowledgeSourceWithdrawals, memories, memoryBlocks } from "./schema/knowledge.ts";
import { chatReplyKnowledge, memoryExtractionDependencies } from "./schema/memory-extraction.ts";

const positive = z.int().positive();
const text = z.string().refine((value) => value.trim().length > 0);
const sourceFields = {
  householdId: businessId,
  sourceMemberId: businessId,
  sourceMessageId: businessId,
  sourceRevision: positive,
};
const factFields = { ...businessFields, ...sourceFields, subjectMemberId: businessId.nullable() };
type Source = z.infer<z.ZodObject<typeof sourceFields>>;

export const replyEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["memory", "diary", "file_description"]), id: businessId, rev: positive }),
  z.strictObject({
    kind: z.literal("message"), sourceMemberId: businessId, sourceMessageId: businessId, sourceRevision: positive,
  }),
]);
const dependencySchema = z.strictObject({ id: businessId, rev: positive });
export type ExtractionDependency = z.infer<typeof dependencySchema>;

export function projectMessageReplica(tx: ReplicationTx, row: typeof messages.$inferSelect) {
  const evidence = tx.select().from(chatReplyKnowledge).where(eq(chatReplyKnowledge.messageId, row.id)).get();
  const { historyContextBlocked, ...business } = row;
  return { ...business, historyContextBlocked: historyContextBlocked || undefined, knowledgeEvidence: evidence?.references ?? [] };
}

export function projectMemoryReplica(tx: ReplicationTx, row: typeof memories.$inferSelect) {
  const dependencies = tx.select({
    id: memoryExtractionDependencies.contextMessageId, rev: memoryExtractionDependencies.contextRevision,
  }).from(memoryExtractionDependencies).where(eq(memoryExtractionDependencies.memoryId, row.id))
    .orderBy(asc(memoryExtractionDependencies.contextMessageId)).all();
  return { ...row, dependencies };
}

function authorizeScope(tx: ReplicationTx, source: ReplicationSource, row: ReplicatedRevision & { householdId: string }) {
  assertReplicaWriter(row.originHostId === source.sourceHostId && row.householdId === source.householdId);
  hostInHousehold(tx, source.sourceHostId, source.householdId);
}

function authorizeSource(tx: ReplicationTx, source: ReplicationSource, row: Source) {
  const member = memberInHousehold(tx, row.sourceMemberId, row.householdId);
  const { message } = messageInHousehold(tx, source, row.sourceMessageId, member.id);
  if (message.rev < row.sourceRevision) {
    requireReplicaDependency(undefined, "message", message.id);
  }
  return { member, message };
}

function authorizeFact(tx: ReplicationTx, source: ReplicationSource, row: ReplicatedRevision & Source & {
  subjectMemberId: string | null;
}) {
  authorizeScope(tx, source, row);
  const { member, message } = authorizeSource(tx, source, row);
  const subject = row.subjectMemberId === null ? null : memberInHousehold(tx, row.subjectMemberId, row.householdId);
  return { owner: subject ?? member, message };
}

function sourceIdentity(row: Source) {
  return [row.householdId, row.sourceMemberId, row.sourceMessageId, row.sourceRevision];
}

const memory = defineReplicationAdapter("memory", z.strictObject({
  ...factFields,
  fingerprint: text,
  predicate: text,
  value: text,
  correctsPrevious: z.boolean(),
  dependencies: z.array(dependencySchema),
}), {
  read(tx, id) {
    const row = tx.select().from(memories).where(eq(memories.id, id)).get();
    return row && projectMemoryReplica(tx, row);
  },
  snapshotRows: (tx, source, limit) => tx.select().from(memories).where(and(
    eq(memories.householdId, source.householdId), eq(memories.originHostId, source.sourceHostId),
  )).orderBy(asc(memories.id)).limit(limit).all().map((row) => projectMemoryReplica(tx, row)),
  write(tx, { dependencies, ...row }) {
    tx.insert(memories).values(row).onConflictDoUpdate({ target: memories.id, set: row }).run();
    if (dependencies.length) {
      tx.insert(memoryExtractionDependencies).values(dependencies.map(({ id, rev }) => ({
        memoryId: row.id, contextMessageId: id, contextRevision: rev,
      }))).onConflictDoNothing().run();
    }
  },
  authorize(tx, source, row) {
    const { message } = authorizeFact(tx, source, row);
    // Extraction follows the original message publisher. Member edits may be
    // authorized by the subject, but they are committed by this same writer.
    assertReplicaWriter(message.originHostId === source.sourceHostId
      && (!row.correctsPrevious || row.subjectMemberId === null || row.subjectMemberId === row.sourceMemberId));
    const ids = new Set<string>();
    for (const { id, rev } of row.dependencies) {
      const proof = messageInHousehold(tx, source, id).message;
      assertReplicaIdentity(id !== message.id && !ids.has(id) && proof.conversationId === message.conversationId);
      if (proof.rev < rev) {
        requireReplicaDependency(undefined, "message", id);
      }
      ids.add(id);
    }
    const existing = tx.select({ id: memories.id }).from(memories).where(and(
      eq(memories.sourceMessageId, row.sourceMessageId), eq(memories.sourceRevision, row.sourceRevision),
      row.subjectMemberId === null ? isNull(memories.subjectMemberId) : eq(memories.subjectMemberId, row.subjectMemberId),
      eq(memories.fingerprint, row.fingerprint),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [...sourceIdentity(row), row.subjectMemberId, row.fingerprint, row.predicate, row.correctsPrevious, row.dependencies],
});

const memoryBlock = defineReplicationAdapter("memory_block", z.strictObject({
  ...factFields,
  fingerprint: text,
}), {
  read: (tx, id) => tx.select().from(memoryBlocks).where(eq(memoryBlocks.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(memoryBlocks).where(and(
    eq(memoryBlocks.householdId, source.householdId), eq(memoryBlocks.originHostId, source.sourceHostId),
  )).orderBy(asc(memoryBlocks.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(memoryBlocks).values(row).onConflictDoUpdate({ target: memoryBlocks.id, set: row }).run(); },
  authorize(tx, source, row) {
    const { owner } = authorizeFact(tx, source, row);
    assertReplicaWriter(owner.homeHostId === source.sourceHostId && row.deletedAt === null && row.rev === 1);
    const existing = tx.select({ id: memoryBlocks.id }).from(memoryBlocks).where(and(
      eq(memoryBlocks.sourceMessageId, row.sourceMessageId), eq(memoryBlocks.sourceRevision, row.sourceRevision),
      row.subjectMemberId === null ? isNull(memoryBlocks.subjectMemberId) : eq(memoryBlocks.subjectMemberId, row.subjectMemberId),
      eq(memoryBlocks.fingerprint, row.fingerprint),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [...sourceIdentity(row), row.subjectMemberId, row.fingerprint],
  fact: (row) => [row.hlc, row.updatedAt],
});

const boundary = defineReplicationAdapter("boundary", z.strictObject({
  ...factFields,
  subjectMemberId: businessId,
  description: text,
}), {
  read: (tx, id) => tx.select().from(boundaries).where(eq(boundaries.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(boundaries).where(and(
    eq(boundaries.householdId, source.householdId), eq(boundaries.originHostId, source.sourceHostId),
  )).orderBy(asc(boundaries.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(boundaries).values(row).onConflictDoUpdate({ target: boundaries.id, set: row }).run(); },
  authorize(tx, source, row) {
    const { owner } = authorizeFact(tx, source, row);
    assertReplicaWriter(owner.id === row.sourceMemberId && owner.homeHostId === source.sourceHostId);
    const existing = tx.select({ id: boundaries.id }).from(boundaries).where(and(
      eq(boundaries.sourceMessageId, row.sourceMessageId), eq(boundaries.sourceRevision, row.sourceRevision),
      eq(boundaries.subjectMemberId, row.subjectMemberId),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [...sourceIdentity(row), row.subjectMemberId],
});

const diary = defineReplicationAdapter("diary_entry", z.strictObject({
  ...businessFields,
  ...sourceFields,
  sourceMessageId: businessId.nullable(),
  sourceRevision: positive.nullable(),
  ownerMemberId: businessId,
  text,
  recordedAt: z.int(),
  localDay: z.iso.date(),
  timeZone: z.string().min(1),
  catAllowed: z.boolean(),
}), {
  read: (tx, id) => tx.select().from(diaryEntries).where(eq(diaryEntries.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(diaryEntries).where(and(
    eq(diaryEntries.householdId, source.householdId), eq(diaryEntries.originHostId, source.sourceHostId),
  )).orderBy(asc(diaryEntries.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(diaryEntries).values(row).onConflictDoUpdate({ target: diaryEntries.id, set: row }).run(); },
  authorize(tx, source, row) {
    authorizeScope(tx, source, row);
    const owner = memberInHousehold(tx, row.ownerMemberId, row.householdId);
    assertReplicaWriter(owner.id === row.sourceMemberId && owner.homeHostId === source.sourceHostId);
    if (!matchesDiaryLocalDay(row) || (row.sourceMessageId === null) !== (row.sourceRevision === null)
      || (row.deletedAt !== null && row.catAllowed)) {
      throw new ReplicationError("invalid_record", "日记日期、来源或撤回许可无效");
    }
    if (row.sourceMessageId !== null && row.sourceRevision !== null) {
      authorizeSource(tx, source, { ...row, sourceMessageId: row.sourceMessageId, sourceRevision: row.sourceRevision });
    }
  },
  identity: (row) => [
    row.householdId, row.ownerMemberId, row.sourceMemberId, row.sourceMessageId, row.sourceRevision,
    row.recordedAt, row.localDay, row.timeZone,
  ],
  equalRevisionOrder: (next, current) => Number(current.catAllowed) - Number(next.catAllowed),
});

const withdrawal = defineReplicationAdapter("knowledge_source_withdrawal", z.strictObject({
  ...businessFields,
  ...sourceFields,
}), {
  read: (tx, id) => tx.select().from(knowledgeSourceWithdrawals).where(eq(knowledgeSourceWithdrawals.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(knowledgeSourceWithdrawals).where(and(
    eq(knowledgeSourceWithdrawals.householdId, source.householdId), eq(knowledgeSourceWithdrawals.originHostId, source.sourceHostId),
  )).orderBy(asc(knowledgeSourceWithdrawals.id)).limit(limit).all(),
  write: (tx, row) => tx.insert(knowledgeSourceWithdrawals).values(row).onConflictDoNothing()
    .returning({ id: knowledgeSourceWithdrawals.id }).get() !== undefined,
  authorize(tx, source, row) {
    authorizeScope(tx, source, row);
    const { member } = authorizeSource(tx, source, row);
    assertReplicaWriter(member.homeHostId === source.sourceHostId && row.deletedAt === null && row.rev === 1);
  },
  identity: sourceIdentity,
  fact: (row) => [row.hlc, row.updatedAt],
});

export const knowledgeReplicas = {
  knowledge_source_withdrawal: withdrawal,
  memory_block: memoryBlock,
  memory,
  boundary,
  diary_entry: diary,
};
