import { and, asc, eq, exists, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { hasValidExtractionDependencies } from "./extraction-evidence.ts";
import { importedMemoryPreferences, matchesImportedMemoryBlock } from "./imported-history.ts";
import { businessRow, revision } from "./business.ts";
import { requireLocalHostId } from "./host-meta.ts";
import { getHouseholdMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { projectMemoryReplica } from "./knowledge-replicas.ts";
import type { ExtractionDependency } from "./knowledge-replicas.ts";
import { appendNativeChange, atomicNativeChanges } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { replicaAdapters } from "./replica-records.ts";
import { memoryExtractionDependencies } from "./schema/memory-extraction.ts";
import { hasKnowledgeSource, readKnowledgeSource } from "./knowledge-source.ts";
import type { KnowledgeSource } from "./knowledge-source.ts";
import { messages } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";
import { boundaries, memories, memoryBlocks } from "./schema/knowledge.ts";

export type Memory = typeof memories.$inferSelect;
export type MemoryBlock = typeof memoryBlocks.$inferSelect;
export type Boundary = typeof boundaries.$inferSelect;

type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "transaction">;
/** null 表示明确的家庭共同主体。未确认的主体不得写入。 */
type FactSource = KnowledgeSource & { subjectMemberId: string | null };
type MemoryInput = FactSource & { fingerprint: string; predicate: string; value: string };
type MemoryAuthor = Pick<Actor, "householdId" | "memberId">;
type FactTable = typeof memories | typeof boundaries | typeof memoryBlocks;

export interface KnowledgeFilter {
  householdId: string;
  id?: string;
  rev?: number;
  subjectMemberId?: string | null;
  sourceMemberId?: string;
  sourceMessageId?: string;
  sourceRevision?: number;
}

function matches(table: FactTable, filter: KnowledgeFilter) {
  return and(
    eq(table.householdId, filter.householdId),
    filter.id === undefined ? undefined : eq(table.id, filter.id),
    filter.rev === undefined ? undefined : eq(table.rev, filter.rev),
    filter.subjectMemberId === undefined ? undefined : sql`${table.subjectMemberId} IS ${filter.subjectMemberId}`,
    filter.sourceMemberId === undefined ? undefined : eq(table.sourceMemberId, filter.sourceMemberId),
    filter.sourceMessageId === undefined ? undefined : eq(table.sourceMessageId, filter.sourceMessageId),
    filter.sourceRevision === undefined ? undefined : eq(table.sourceRevision, filter.sourceRevision),
  );
}

function activeSubject(db: Reader, table: FactTable) {
  return or(isNull(table.subjectMemberId), exists(db.select({ id: members.id }).from(members).where(and(
    eq(members.id, table.subjectMemberId),
    eq(members.householdId, table.householdId),
    isNull(members.deletedAt),
  ))));
}

function available(db: Reader, table: FactTable, filter: KnowledgeFilter) {
  return and(
    matches(table, filter),
    isNull(table.deletedAt),
    activeSubject(db, table),
    hasKnowledgeSource(db, table),
  );
}

type BlockFilter = {
  householdId: typeof memories.householdId | string;
  subjectMemberId: typeof memories.subjectMemberId | string | null;
  sourceMemberId: typeof memories.sourceMemberId | string;
  fingerprint: typeof memories.fingerprint | string;
};

export function matchingMemoryBlocks(db: Reader, filter: BlockFilter) {
  return db.select({ id: memoryBlocks.id }).from(memoryBlocks).where(and(
    eq(memoryBlocks.householdId, filter.householdId),
    sql`${memoryBlocks.subjectMemberId} IS ${filter.subjectMemberId}`,
    or(sql`${memoryBlocks.subjectMemberId} IS NOT NULL`, eq(memoryBlocks.sourceMemberId, filter.sourceMemberId)),
    eq(memoryBlocks.fingerprint, filter.fingerprint),
    isNull(memoryBlocks.deletedAt),
  ));
}

function provenance<T extends string | null>(input: KnowledgeSource & { subjectMemberId: T }) {
  return {
    householdId: input.householdId,
    subjectMemberId: input.subjectMemberId,
    sourceMemberId: input.sourceMemberId,
    sourceMessageId: input.sourceMessageId,
    sourceRevision: input.sourceRevision,
  };
}

function validFactSource(db: Reader, input: FactSource) {
  return (input.subjectMemberId === null || getHouseholdMember(db, input.householdId, input.subjectMemberId))
    && readKnowledgeSource(db, input);
}

function requireText(text: string) {
  if (!text.trim()) {
    throw new TypeError("记忆字段或边界说明不能为空");
  }
}

function memoryForSource(db: Reader, source: FactSource, fingerprint: string) {
  return db.select().from(memories).where(and(
    matches(memories, source), eq(memories.fingerprint, fingerprint),
  )).get();
}

function appendMemory(tx: ReplicationTx, row: Memory | undefined) {
  if (row) {
    appendNativeChange(tx, row.originHostId, row.householdId, replicaAdapters.memory, projectMemoryReplica(tx, row));
  }
  return row;
}

function writeMemory(
  db: ReplicationTx, clock: Clock, input: MemoryInput, correctsPrevious: boolean, dependencies: readonly ExtractionDependency[],
) {
  const { fingerprint, predicate, value } = input;
  const source = provenance(input);
  const origin = validFactSource(db, source);
  const originHostId = requireLocalHostId(db);
  if (origin?.originHostId !== originHostId || matchingMemoryBlocks(db, { ...source, fingerprint }).get()
    || matchesImportedMemoryBlock(db, source.subjectMemberId, predicate)) {
    return undefined;
  }
  const current = memoryForSource(db, source, fingerprint);
  if (current) {
    return current.deletedAt === null ? current : undefined;
  }
  // An earlier job may retry after a later correction has already committed.
  const newerCorrection = db.select({ id: memories.id }).from(memories)
    .innerJoin(messages, eq(messages.id, memories.sourceMessageId))
    .where(and(
      matches(memories, { householdId: source.householdId, subjectMemberId: source.subjectMemberId }),
      eq(memories.fingerprint, fingerprint),
      eq(memories.correctsPrevious, true),
      source.subjectMemberId === null ? eq(memories.sourceMemberId, source.sourceMemberId) : undefined,
      or(gt(messages.hlc, origin.hlc), and(eq(messages.hlc, origin.hlc), gt(messages.id, origin.id))),
    )).limit(1).get();
  if (newerCorrection) {
    return undefined;
  }
  const written = db.insert(memories).values({
    ...businessRow(clock, originHostId), ...source, fingerprint, predicate, value, correctsPrevious,
  }).returning().get()!;
  if (dependencies.length) {
    db.insert(memoryExtractionDependencies).values(dependencies.map(({ id, rev }) => ({
      memoryId: written.id, contextMessageId: id, contextRevision: rev,
    }))).run();
  }
  return appendMemory(db, written);
}

/** 保存已确定主体的事实。重复提取返回现有修订，撤回或屏蔽返回 undefined。 */
export function saveMemory(
  db: Writer, clock: Clock, input: MemoryInput, dependencies: readonly ExtractionDependency[] = [],
): Memory | undefined {
  requireText(input.fingerprint);
  requireText(input.predicate);
  requireText(input.value);
  return db.transaction((tx) => writeMemory(tx, clock, input, false, dependencies), { behavior: "immediate" });
}

/** 屏蔽只取成员与指纹；用于屏蔽的原话被停用时仍保留屏蔽。 */
export function createMemoryBlock(
  db: Writer, clock: Clock, input: FactSource & { fingerprint: string },
): MemoryBlock | undefined {
  return persistMemoryBlock(db, clock, input, false);
}

/** 原创宿主已确认撤回。此后原话停用仍保留本人同指纹的屏蔽。 */
export function confirmPeerMemoryBlock(db: Writer, clock: Clock, memory: Memory): MemoryBlock | undefined {
  return persistMemoryBlock(db, clock, memory, true);
}

function persistMemoryBlock(
  db: Writer, clock: Clock, input: FactSource & { fingerprint: string }, confirmedWithdrawal: boolean,
): MemoryBlock | undefined {
  const { fingerprint } = input;
  requireText(fingerprint);
  const source = provenance(input);
  return db.transaction((tx) => {
    const hostId = requireLocalHostId(tx);
    const owner = getHouseholdMember(tx, source.householdId, source.subjectMemberId ?? source.sourceMemberId);
    if (owner?.homeHostId !== hostId || (!confirmedWithdrawal && !validFactSource(tx, source))) {
      return undefined;
    }
    const current = tx.select().from(memoryBlocks).where(and(
      matches(memoryBlocks, source), eq(memoryBlocks.fingerprint, fingerprint),
    )).get();
    if (current) {
      return current.deletedAt === null ? current : undefined;
    }
    const row = tx.insert(memoryBlocks).values({
      ...businessRow(clock, hostId), ...source, fingerprint,
    }).returning().get()!;
    appendNativeChange(tx, hostId, row.householdId, replicaAdapters.memory_block, row);
    return row;
  }, { behavior: "immediate" });
}

export function createBoundary(
  db: Writer, clock: Clock, input: KnowledgeSource & { subjectMemberId: string; description: string },
): Boundary | undefined {
  const { description } = input;
  requireText(description);
  const source = provenance(input);
  return db.transaction((tx) => {
    const hostId = requireLocalHostId(tx);
    const owner = getHouseholdMember(tx, source.householdId, source.subjectMemberId);
    if (owner?.homeHostId !== hostId || owner.id !== source.sourceMemberId || !validFactSource(tx, source)) {
      return undefined;
    }
    const current = tx.select().from(boundaries).where(matches(boundaries, source)).get();
    if (current) {
      return current.deletedAt === null ? current : undefined;
    }
    const row = tx.insert(boundaries).values({
      ...businessRow(clock, hostId), ...source, description,
    }).returning().get()!;
    return appendBoundary(tx, row);
  }, { behavior: "immediate" });
}

/** 本人更正对迟到的旧原创也生效，保留不同宿主对各自原创行的写权。 */
export function matchingNewerCorrections(db: Reader) {
  const earlier = alias(messages, "correction_earlier");
  const later = alias(messages, "correction_later");
  const correction = alias(memories, "newer_correction");
  return db.select({ id: correction.id }).from(correction)
    .innerJoin(later, eq(later.id, correction.sourceMessageId))
    .innerJoin(earlier, eq(earlier.id, memories.sourceMessageId)).where(and(
      eq(correction.householdId, memories.householdId),
      sql`${correction.subjectMemberId} IS ${memories.subjectMemberId}`,
      or(and(isNull(memories.subjectMemberId), eq(correction.sourceMemberId, memories.sourceMemberId)),
        eq(correction.sourceMemberId, memories.subjectMemberId)),
      eq(correction.fingerprint, memories.fingerprint),
      eq(correction.correctsPrevious, true),
      or(gt(later.hlc, earlier.hlc), and(eq(later.hlc, earlier.hlc), gt(later.id, earlier.id))),
    ));
}

export function isSupersededMemory(db: Reader, id: string) {
  return db.select({ id: memories.id }).from(memories)
    .where(and(eq(memories.id, id), exists(matchingNewerCorrections(db)))).get() !== undefined;
}

/** 返回可用候选的稳定顺序，调用方负责排序、容量及上下文策略。 */
export function listAvailableMemories(
  db: Reader, filter: KnowledgeFilter & { fingerprint?: string },
): Memory[] {
  return db.select().from(memories).where(and(
    available(db, memories, filter),
    filter.fingerprint === undefined ? undefined : eq(memories.fingerprint, filter.fingerprint),
    notExists(matchingMemoryBlocks(db, memories)),
    notExists(matchingNewerCorrections(db)),
    hasValidExtractionDependencies(db, memories.id),
  )).orderBy(asc(memories.id)).all();
}

/** Model use preserves the prior host owner's permission in addition to source proof. */
export function listRecallMemories(db: Reader, filter: KnowledgeFilter): Memory[] {
  return listAvailableMemories(db, filter).filter((row) => {
    const affectedMembers = new Set([row.sourceMemberId, row.subjectMemberId]);
    return ![...affectedMembers].some((id) => id && importedMemoryPreferences(db, id)?.recallDisabled)
      && !matchesImportedMemoryBlock(db, row.subjectMemberId, row.predicate);
  });
}

export function listMemoryBlocks(db: Reader, filter: KnowledgeFilter & { fingerprint?: string }): MemoryBlock[] {
  return db.select().from(memoryBlocks).where(and(
    matches(memoryBlocks, filter),
    isNull(memoryBlocks.deletedAt),
    activeSubject(db, memoryBlocks),
    filter.fingerprint === undefined ? undefined : eq(memoryBlocks.fingerprint, filter.fingerprint),
  )).orderBy(asc(memoryBlocks.id)).all();
}

export function listAvailableBoundaries(db: Reader, filter: KnowledgeFilter): Boundary[] {
  return db.select().from(boundaries).where(available(db, boundaries, filter)).orderBy(asc(boundaries.id)).all();
}

export function getMemoryRecord(db: Reader, filter: KnowledgeFilter & { id: string }) {
  return db.select().from(memories).where(matches(memories, filter)).get();
}

export function getBoundaryRecord(db: Reader, filter: KnowledgeFilter) {
  return db.select().from(boundaries).where(matches(boundaries, filter)).get();
}

export function canManageMemory(actor: MemoryAuthor, memory: Memory): boolean {
  return memory.householdId === actor.householdId && (memory.subjectMemberId === actor.memberId
    || memory.subjectMemberId === null && memory.sourceMemberId === actor.memberId);
}

function actorFact(
  db: Reader, table: FactTable, actor: MemoryAuthor, id: string, expectedRevision: number,
) {
  return and(
    matches(table, { householdId: actor.householdId, id, rev: expectedRevision }),
    or(eq(table.subjectMemberId, actor.memberId), and(
      isNull(table.subjectMemberId), eq(table.sourceMemberId, actor.memberId),
    )),
    activeSubject(db, table),
    eq(table.originHostId, requireLocalHostId(db)),
    isNull(table.deletedAt),
  );
}

/** 新原话明确更正旧事实，保留两个来源及旧墓碑，防止迟到提取重放旧值。 */
export function replaceMemory(
  db: Writer, clock: Clock, actor: MemoryAuthor, id: string, expectedRevision: number, input: MemoryInput,
  dependencies: readonly ExtractionDependency[] = [],
): Memory | undefined {
  requireText(input.fingerprint);
  requireText(input.predicate);
  requireText(input.value);
  if (input.sourceMemberId !== actor.memberId || input.householdId !== actor.householdId) {
    return undefined;
  }
  return db.transaction((tx) => atomicNativeChanges(tx, requireLocalHostId(tx), () => {
    const previous = tx.select().from(memories).where(and(
      matches(memories, { householdId: actor.householdId, subjectMemberId: input.subjectMemberId, id }),
      eq(memories.fingerprint, input.fingerprint),
      eq(memories.originHostId, requireLocalHostId(tx)),
    )).get();
    if (!previous || previous.sourceMessageId === input.sourceMessageId
      || !(previous.subjectMemberId === actor.memberId
        || previous.subjectMemberId === null && previous.sourceMemberId === actor.memberId)) {
      return undefined;
    }
    if (previous.deletedAt !== null) {
      return previous.rev === expectedRevision + 1
        ? listAvailableMemories(tx, { ...provenance(input), fingerprint: input.fingerprint })[0]
        : undefined;
    }
    if (previous.rev !== expectedRevision) {
      return undefined;
    }
    const corrected = writeMemory(tx, clock, input, true, dependencies);
    if (!corrected) {
      return undefined;
    }
    const update = revision(clock);
    appendMemory(tx, tx.update(memories).set({
      ...update, rev: previous.rev + 1, deletedAt: update.updatedAt,
    }).where(eq(memories.id, previous.id)).returning().get());
    return corrected;
  }), { behavior: "immediate" });
}

/** 本人更正同一指纹的旧值。共同记忆与手工替换使用相同的来源权限。 */
export function saveCorrectedMemory(
  db: Writer, clock: Clock, input: MemoryInput, dependencies: readonly ExtractionDependency[] = [],
): Memory | undefined {
  const actor = { householdId: input.householdId, memberId: input.sourceMemberId };
  if (input.subjectMemberId !== null && input.subjectMemberId !== actor.memberId) {
    return undefined;
  }
  return db.transaction((tx) => atomicNativeChanges(tx, requireLocalHostId(tx), () => {
    const origin = validFactSource(tx, input);
    if (!origin) {
      return undefined;
    }
    const previous = tx.select({ id: memories.id, rev: memories.rev }).from(memories)
      .innerJoin(messages, eq(messages.id, memories.sourceMessageId)).where(and(
        matches(memories, { householdId: input.householdId, subjectMemberId: input.subjectMemberId }),
        eq(memories.fingerprint, input.fingerprint),
        eq(memories.originHostId, requireLocalHostId(tx)),
        isNull(memories.deletedAt),
        input.subjectMemberId === null ? eq(memories.sourceMemberId, actor.memberId) : undefined,
        or(lt(messages.hlc, origin.hlc), and(eq(messages.hlc, origin.hlc), lt(messages.id, origin.id))),
      )).all();
    if (previous.length === 0) {
      return writeMemory(tx, clock, input, true, dependencies);
    }
    let saved: Memory | undefined;
    for (const { id, rev } of previous) {
      saved = replaceMemory(tx, clock, actor, id, rev, input, dependencies) ?? saved;
    }
    return saved;
  }), { behavior: "immediate" });
}

export function reviseMemory(
  db: Writer, clock: Clock, actor: MemoryAuthor, id: string, expectedRevision: number, value: string,
): Memory | undefined {
  requireText(value);
  return db.transaction((tx) => appendMemory(tx, tx.update(memories).set({
    ...revision(clock), rev: expectedRevision + 1, value,
  }).where(and(
    actorFact(tx, memories, actor, id, expectedRevision),
    hasKnowledgeSource(tx, memories),
    hasValidExtractionDependencies(tx, memories.id),
    notExists(matchingMemoryBlocks(tx, memories)),
    notExists(matchingNewerCorrections(tx)),
  )).returning().get()), { behavior: "immediate" });
}

export function withdrawMemory(
  db: Writer, clock: Clock, actor: MemoryAuthor, id: string, expectedRevision: number,
): Memory | undefined {
  return db.transaction((tx) => {
    const update = revision(clock);
    return appendMemory(tx, tx.update(memories).set({
      ...update, rev: expectedRevision + 1, deletedAt: update.updatedAt,
    }).where(actorFact(tx, memories, actor, id, expectedRevision)).returning().get());
  }, { behavior: "immediate" });
}

/** 成员撤回整个方面；共同主体仅撤回同一来源成员的事实。 */
export function forgetMemory(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number,
): Memory | undefined {
  return db.transaction((tx) => atomicNativeChanges(tx, requireLocalHostId(tx), () => {
    const memory = listAvailableMemories(tx, { householdId: actor.householdId, id, rev: expectedRevision })[0];
    if (!memory || memory.originHostId !== requireLocalHostId(tx)
      || !canManageMemory(actor, memory) || !createMemoryBlock(tx, clock, memory)) {
      return undefined;
    }
    const update = revision(clock);
    const tombstones = tx.update(memories).set({
      ...update, rev: sql`${memories.rev} + 1`, deletedAt: update.updatedAt,
    }).where(and(
      matches(memories, {
        householdId: actor.householdId,
        subjectMemberId: memory.subjectMemberId,
        sourceMemberId: memory.subjectMemberId === null ? actor.memberId : undefined,
      }),
      eq(memories.fingerprint, memory.fingerprint),
      eq(memories.originHostId, memory.originHostId),
      isNull(memories.deletedAt),
    )).returning().all();
    for (const row of tombstones) {
      appendMemory(tx, row);
    }
    return tombstones.find((row) => row.id === id);
  }), { behavior: "immediate" });
}

function appendBoundary(tx: ReplicationTx, row: Boundary | undefined) {
  if (row) {
    appendNativeChange(tx, row.originHostId, row.householdId, replicaAdapters.boundary, row);
  }
  return row;
}

export function reviseBoundary(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number, description: string,
): Boundary | undefined {
  requireText(description);
  return db.transaction((tx) => appendBoundary(tx, tx.update(boundaries).set({
    ...revision(clock), rev: expectedRevision + 1, description,
  }).where(and(
    actorFact(tx, boundaries, actor, id, expectedRevision),
    hasKnowledgeSource(tx, boundaries),
  )).returning().get()), { behavior: "immediate" });
}

export function withdrawBoundary(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number,
): Boundary | undefined {
  return db.transaction((tx) => {
    const update = revision(clock);
    return appendBoundary(tx, tx.update(boundaries).set({
      ...update, rev: expectedRevision + 1, deletedAt: update.updatedAt,
    }).where(actorFact(tx, boundaries, actor, id, expectedRevision)).returning().get());
  }, { behavior: "immediate" });
}
