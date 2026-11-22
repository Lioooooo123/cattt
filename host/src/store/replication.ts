import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ReplicationError, replicationCursorSchema, replicationSourceSchema,
} from "../replication/types.ts";
import type {
  ApplyPageResult, ChangePage, ReplicatedRevision, ReplicationChange, ReplicationCursor, ReplicationSource,
} from "../replication/types.ts";
import { ticketReplicaAdapters } from "./ticket-replica-records.ts";
import { getHostMeta, setHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { NativeReplicaRecord } from "./replica-records.ts";
import { MissingReplicationDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { hosts, households, members } from "./schema/identity.ts";
import { knowledgeReplicas, projectMessageReplica } from "./knowledge-replicas.ts";
import { chatReplyKnowledge } from "./schema/memory-extraction.ts";
import { changeLog, peerCursors, replicationState, retiredPeerGenerations } from "./schema/replication.ts";

type Reader = Pick<StoreDb, "select">;
type ReplicationDb = Pick<StoreDb, "transaction">;
type NativeChange = ReplicationChange<NativeReplicaRecord>;
type NativeChangePage = ChangePage<NativeReplicaRecord>;

export const MAX_CHANGE_PAGE = 500;

export const replicaRecordSchema = z.strictObject({
  kind: z.string().min(1),
  row: z.unknown(),
});
const changeSchema = replicaRecordSchema.extend(replicationCursorSchema.shape);
export const changePageSchema = z.strictObject({
  from: replicationCursorSchema,
  next: replicationCursorSchema,
  changes: z.array(changeSchema).max(MAX_CHANGE_PAGE),
  hasMore: z.boolean(),
});

function parseCursor(input: unknown): ReplicationCursor {
  const cursor = replicationCursorSchema.safeParse(input);
  if (!cursor.success) {
    throw new ReplicationError("invalid_cursor", "复制游标格式无效");
  }
  return cursor.data;
}

function parseSource(input: unknown): ReplicationSource {
  const source = replicationSourceSchema.safeParse(input);
  if (!source.success) {
    throw new ReplicationError("source_mismatch", "缺少有效的来源宿主、世代或家庭绑定");
  }
  return source.data;
}

function bindCursor(cursor: ReplicationCursor, source: Pick<ReplicationCursor, "sourceHostId" | "generation">, head?: ReplicationCursor) {
  if (cursor.sourceHostId !== source.sourceHostId) {
    throw new ReplicationError("source_mismatch", "游标属于另一来源宿主");
  }
  if (cursor.generation !== source.generation) {
    throw new ReplicationError("reset_required", "恢复世代已变化，须安装新快照及水位", head);
  }
}

function requireLocalHost(db: Reader, sourceHostId: string): void {
  if (getHostMeta(db, "host_id") !== sourceHostId) {
    throw new ReplicationError("source_mismatch", "只能读写本机的原生复制日志");
  }
}

function nativeState(db: Reader, sourceHostId: string) {
  return db.select().from(replicationState).where(eq(replicationState.sourceHostId, sourceHostId)).get();
}

function requireNativeState(db: Reader, sourceHostId: string) {
  requireLocalHost(db, sourceHostId);
  const state = nativeState(db, sourceHostId);
  if (!state) {
    throw new ReplicationError("source_uninitialized", "本机复制日志尚未初始化");
  }
  return state;
}

function stateHead(state: typeof replicationState.$inferSelect): ReplicationCursor {
  return { sourceHostId: state.sourceHostId, generation: state.generation, seq: state.lastSeq };
}

function adapterFor(kind: string) {
  if (!Object.hasOwn(replicaAdapters, kind)) {
    throw new ReplicationError("unsupported_kind", `不支持的复制记录类型：${kind}`);
  }
  return replicaAdapters[kind as keyof typeof replicaAdapters];
}

export function getReplicationHead(db: Reader, sourceHostId: string): ReplicationCursor {
  return stateHead(requireNativeState(db, sourceHostId));
}

export function nativeMessageExists(db: Reader, cursor: ReplicationCursor, messageId: string, revision: number) {
  return db.select({ seq: changeLog.seq }).from(changeLog).where(and(
    eq(changeLog.sourceHostId, cursor.sourceHostId), eq(changeLog.generation, cursor.generation),
    eq(changeLog.kind, "message"), sql`json_extract(${changeLog.payload}, '$.id') = ${messageId}`,
    sql`json_extract(${changeLog.payload}, '$.rev') = ${revision}`,
  )).limit(1).get() !== undefined;
}

export function getNativeReplicationSource(db: Reader, sourceHostId: string): ReplicationSource {
  const { generation } = getReplicationHead(db, sourceHostId);
  const host = db.select().from(hosts).where(eq(hosts.id, sourceHostId)).get();
  if (!host) {
    throw new ReplicationError("source_uninitialized", "本机宿主资料尚未初始化");
  }
  return parseSource({ sourceHostId, generation, householdId: host.householdId });
}

// Recovery callers rotate before serving a restored database. Only a confirmed
// snapshot watermark makes a new generation eligible for incremental pull.
export function rotateReplicationGeneration(db: ReplicationDb, sourceHostId: string): ReplicationCursor {
  return db.transaction((tx) => {
    requireNativeState(tx, sourceHostId);
    const state = tx.update(replicationState).set({
      generation: crypto.randomUUID(), lastSeq: 0, snapshotRequired: true,
    }).where(eq(replicationState.sourceHostId, sourceHostId)).returning().get()!;
    return stateHead(state);
  }, { behavior: "immediate" });
}

// Call inside the same transaction as the business mutation.
export function appendNativeChange<Kind extends keyof typeof replicaAdapters, Row extends ReplicatedRevision>(
  tx: ReplicationTx, sourceHostId: string, householdId: string,
  adapter: {
    kind: Kind;
    project(source: ReplicationSource, tx: ReplicationTx, input: Row): { kind: Kind; row: Row };
  },
  row: NoInfer<Row>,
): ReplicationCursor {
  if (!Object.is(replicaAdapters[adapter.kind], adapter)) {
    throw new ReplicationError("unsupported_kind", "原生日志只接受已登记的业务投影");
  }
  const state = requireNativeState(tx, sourceHostId);
  const source: ReplicationSource = { sourceHostId, generation: state.generation, householdId };
  const record = adapter.project(source, tx, row);
  return appendNativeRecord(tx, record, state);
}

function appendNativeRecord(
  tx: ReplicationTx, record: { kind: string; row: ReplicatedRevision },
  state = requireNativeState(tx, record.row.originHostId),
) {
  const { sourceHostId } = state;
  const cursor = { sourceHostId, generation: state.generation, seq: state.lastSeq + 1 };
  parseCursor(cursor);
  tx.insert(changeLog).values({ ...cursor, kind: record.kind, payload: JSON.stringify(record.row) }).run();
  tx.update(replicationState).set({ lastSeq: cursor.seq }).where(eq(replicationState.sourceHostId, sourceHostId)).run();
  return cursor;
}

/** A compound knowledge edit is also indivisible at the incremental page boundary. */
export function atomicNativeChanges<T>(tx: ReplicationTx, sourceHostId: string, write: () => T): T {
  const before = getReplicationHead(tx, sourceHostId);
  const result = write();
  const after = getReplicationHead(tx, sourceHostId);
  if (after.seq > before.seq + 1) {
    tx.update(changeLog).set({ transactionEndSeq: after.seq }).where(and(
      eq(changeLog.sourceHostId, sourceHostId), eq(changeLog.generation, before.generation),
      gt(changeLog.seq, before.seq), lte(changeLog.seq, after.seq),
    )).run();
  }
  return result;
}

const TICKET_BACKFILL_KEY = "r6_10_ticket_replication";
const KNOWLEDGE_BACKFILL_KEY = "r6_11_knowledge_replication";

// Existing R2/R3 stores get a baseline once, before new business mutations.
export function initializeNativeReplication(
  tx: ReplicationTx, sourceHostId: string, householdId: string, snapshotRequired = false,
): void {
  requireLocalHost(tx, sourceHostId);
  if (nativeState(tx, sourceHostId)) {
    return;
  }
  tx.insert(replicationState).values({ sourceHostId, generation: crypto.randomUUID(), lastSeq: 0, snapshotRequired }).run();
  if (snapshotRequired) {
    setHostMeta(tx, TICKET_BACKFILL_KEY, "1");
    setHostMeta(tx, KNOWLEDGE_BACKFILL_KEY, "1");
    return;
  }

  const family = tx.select().from(households).where(eq(households.id, householdId)).get()!;
  if (family.originHostId === sourceHostId) {
    appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.household, family);
  }
  const host = tx.select().from(hosts).where(eq(hosts.id, sourceHostId)).get()!;
  appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.host, host);

  for (const member of tx.select().from(members).where(and(
    eq(members.householdId, householdId), eq(members.originHostId, sourceHostId),
  )).orderBy(asc(members.id)).all()) {
    appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.member, member);
  }
  for (const conversation of tx.select().from(conversations).where(and(
    eq(conversations.householdId, householdId), eq(conversations.originHostId, sourceHostId),
  )).orderBy(asc(conversations.id)).all()) {
    appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.conversation, conversation);
  }
  for (const { participant } of tx.select({ participant: participants }).from(participants)
    .innerJoin(conversations, eq(participants.conversationId, conversations.id)).where(and(
      eq(conversations.householdId, householdId), eq(participants.originHostId, sourceHostId),
    )).orderBy(asc(participants.id)).all()) {
    appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.participant, participant);
  }
  // Old R3 requires the reply target to exist at insertion. Use the established
  // local insertion order even when a restart or wall clock skew reorders HLCs.
  for (const { message } of tx.select({ message: messages }).from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(and(
      eq(conversations.householdId, householdId), eq(messages.originHostId, sourceHostId),
    )).orderBy(sql`"messages".rowid`).all()) {
    appendNativeChange(tx, sourceHostId, householdId, replicaAdapters.message, projectMessageReplica(tx, message));
  }
}

// Pre-R6.10 rows already have original IDs. Seed their final revision once,
// even when R5.5 already initialized its replication stream.
export function backfillTicketReplication(tx: ReplicationTx, hostId: string, householdId: string) {
  const key = TICKET_BACKFILL_KEY;
  if (getHostMeta(tx, key)) return;
  const source = getNativeReplicationSource(tx, hostId);
  if (source.householdId !== householdId) throw new Error("事项复制来源不属于当前家庭");
  for (const adapter of Object.values(ticketReplicaAdapters)) {
    for (const record of adapter.snapshot(source, tx, Number.MAX_SAFE_INTEGER)) {
      // The original adapter already projected and checked each row.
      appendNativeRecord(tx, record);
    }
  }
  setHostMeta(tx, key, "1");
}

// R4/R6.10 could write knowledge and reply proofs before their replica kinds
// existed. Publish those facts once without running any business mutation.
export function backfillKnowledgeReplication(tx: ReplicationTx, hostId: string, householdId: string) {
  const key = KNOWLEDGE_BACKFILL_KEY;
  if (getHostMeta(tx, key)) return;
  const source = getNativeReplicationSource(tx, hostId);
  if (source.householdId !== householdId) throw new Error("知识复制来源不属于当前家庭");
  // The native baseline and earlier releases may already contain withdrawals
  // and boundaries. Preserve their log sequence and only add missing revisions.
  const published = new Set(tx.select({ kind: changeLog.kind, payload: changeLog.payload }).from(changeLog)
    .where(and(eq(changeLog.sourceHostId, hostId), eq(changeLog.generation, source.generation),
      inArray(changeLog.kind, Object.keys(knowledgeReplicas)))).all()
    .map(({ kind, payload }) => {
      const { id, rev } = JSON.parse(payload) as ReplicatedRevision;
      return JSON.stringify([kind, id, rev]);
    }));
  for (const adapter of Object.values(knowledgeReplicas)) {
    for (const record of adapter.snapshot(source, tx, Number.MAX_SAFE_INTEGER)) {
      if (!published.has(JSON.stringify([record.kind, record.row.id, record.row.rev]))) {
        appendNativeRecord(tx, record);
      }
    }
  }
  for (const { row } of tx.select({ row: messages }).from(messages)
    .innerJoin(chatReplyKnowledge, eq(chatReplyKnowledge.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(and(
      eq(conversations.householdId, householdId), eq(messages.originHostId, hostId),
    )).orderBy(asc(messages.id)).all()) {
    appendNativeChange(tx, hostId, householdId, replicaAdapters.message, projectMessageReplica(tx, row));
  }
  setHostMeta(tx, key, "1");
}

// Only the pristine-household join transaction may discard a bootstrap stream.
export function rebasePristineReplication(tx: ReplicationTx, hostId: string, householdId: string) {
  requireLocalHost(tx, hostId);
  tx.delete(changeLog).where(eq(changeLog.sourceHostId, hostId)).run();
  tx.delete(replicationState).where(eq(replicationState.sourceHostId, hostId)).run();
  initializeNativeReplication(tx, hostId, householdId);
}

export function readChangePage(
  db: ReplicationDb, sourceHostId: string, cursor: ReplicationCursor | null = null, limit = 100,
): NativeChangePage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_PAGE) {
    throw new ReplicationError("invalid_page", "复制页大小无效");
  }
  return db.transaction((tx) => {
    const state = requireNativeState(tx, sourceHostId);
    const head = stateHead(state);
    const from = cursor === null ? { ...head, seq: 0 } : parseCursor(cursor);
    bindCursor(from, head, head);
    if (cursor === null && state.snapshotRequired) {
      throw new ReplicationError("reset_required", "恢复后的原生流须从快照水位开始", head);
    }
    if (from.seq > head.seq) {
      throw new ReplicationError("cursor_ahead", "游标超过本机原生水位", head);
    }
    const rows = tx.select().from(changeLog).where(and(
      eq(changeLog.sourceHostId, sourceHostId), eq(changeLog.generation, from.generation), gt(changeLog.seq, from.seq),
    )).orderBy(asc(changeLog.seq)).limit(limit).all();
    if (rows.length !== Math.min(limit, head.seq - from.seq)
      || rows.some((row, i) => row.seq !== from.seq + i + 1)) {
      throw new ReplicationError("reset_required", "所需增量已不连续，须安装快照", head);
    }
    const lastSeq = rows.at(-1)?.seq ?? from.seq;
    const split = rows.findIndex((row) => (row.transactionEndSeq ?? row.seq) > lastSeq);
    if (split === 0) {
      throw new ReplicationError("reset_required", "单次业务修改超过请求页容量，须安装快照", head);
    }
    const complete = split < 0 ? rows : rows.slice(0, split);
    const changes = complete.map(({ sourceHostId, generation, seq, kind, payload }) => ({
      sourceHostId, generation, seq, ...adapterFor(kind).decode(JSON.parse(payload)),
    }));
    const next = { ...from, seq: complete.at(-1)?.seq ?? from.seq };
    return { from, next, changes, hasMore: next.seq < head.seq };
  });
}

function storedCursor(db: Reader, sourceHostId: string) {
  return db.select().from(peerCursors).where(eq(peerCursors.sourceHostId, sourceHostId)).get();
}

export function getPeerCursor(db: Reader, sourceHostId: string): ReplicationCursor | null {
  const row = storedCursor(db, sourceHostId);
  return row ? { sourceHostId: row.sourceHostId, generation: row.generation, seq: row.seq } : null;
}

export function assertRemoteScope(db: Reader, source: ReplicationSource) {
  const localId = getHostMeta(db, "host_id");
  const local = localId ? db.select().from(hosts).where(eq(hosts.id, localId)).get() : undefined;
  const remote = db.select().from(hosts).where(eq(hosts.id, source.sourceHostId)).get();
  const cursor = storedCursor(db, source.sourceHostId);
  if (localId === source.sourceHostId || (local && local.householdId !== source.householdId)
    || (remote && remote.householdId !== source.householdId) || (cursor && cursor.householdId !== source.householdId)) {
    throw new ReplicationError("source_mismatch", "复制来源与本机或已绑定家庭不匹配");
  }
}

function writePeerCursor(tx: ReplicationTx, source: ReplicationSource, cursor: ReplicationCursor): void {
  tx.insert(peerCursors).values({ ...cursor, householdId: source.householdId }).onConflictDoUpdate({
    target: peerCursors.sourceHostId,
    set: { generation: cursor.generation, seq: cursor.seq },
  }).run();
}

// Snapshot workers call this in the transaction that merges the snapshot.
export function installReplicationWatermark(
  tx: ReplicationTx, authenticatedSource: ReplicationSource, watermark: ReplicationCursor,
  expected: ReplicationCursor | null,
): void {
  const source = parseSource(authenticatedSource);
  const next = parseCursor(watermark);
  bindCursor(next, source);
  assertRemoteScope(tx, source);
  const current = getPeerCursor(tx, source.sourceHostId);
  if (expected !== null) {
    parseCursor(expected);
  }
  if (current?.sourceHostId !== expected?.sourceHostId || current?.generation !== expected?.generation
    || current?.seq !== expected?.seq || (current?.generation === next.generation && current.seq > next.seq)) {
    throw new ReplicationError("watermark_conflict", "复制游标已变化或快照水位落后，需重新读取");
  }
  if (current && current.generation !== next.generation) {
    const retired = retiredPeerGenerations;
    if (tx.select().from(retired).where(and(
      eq(retired.sourceHostId, source.sourceHostId), eq(retired.generation, next.generation),
    )).get()) {
      throw new ReplicationError("watermark_conflict", "已退休的复制世代不能重新安装");
    }
    tx.insert(retired).values({ sourceHostId: current.sourceHostId, generation: current.generation }).run();
  }
  writePeerCursor(tx, source, next);
}

// Shared, data-only merge for incremental pulls and future snapshot imports.
// The caller assigns each record's trusted original producer and transaction.
export function applyReplicaRecord(tx: ReplicationTx, producer: ReplicationSource, input: unknown): boolean {
  const record = replicaRecordSchema.safeParse(input);
  if (!record.success) {
    throw new ReplicationError("invalid_record", "复制记录格式无效");
  }
  return adapterFor(record.data.kind).apply(tx, parseSource(producer), record.data.row);
}

export class PageWaitingError extends Error {
  constructor(public readonly result: Extract<ApplyPageResult, { status: "waiting" }>) {
    super("复制页仍缺少依赖");
  }
}

export function applyReplicaBatch<T>(
  pending: readonly T[], cursor: ReplicationCursor | null, apply: (record: T) => boolean,
): number {
  let applied = 0;
  while (pending.length > 0) {
    const waiting: T[] = [];
    const missing = new Map<string, MissingReplicationDependency["dependency"]>();
    for (const record of pending) {
      try {
        applied += Number(apply(record));
      } catch (error) {
        if (!(error instanceof MissingReplicationDependency)) {
          throw error;
        }
        waiting.push(record);
        missing.set(JSON.stringify(error.dependency), error.dependency);
      }
    }
    if (waiting.length === pending.length) {
      throw new PageWaitingError({ status: "waiting", cursor, missing: [...missing.values()] });
    }
    pending = waiting;
  }
  return applied;
}

export function applyChangePage(db: ReplicationDb, authenticatedSource: ReplicationSource, input: unknown): ApplyPageResult {
  const source = parseSource(authenticatedSource);
  const parsed = changePageSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReplicationError("invalid_page", "复制页格式无效");
  }
  const { from, next, changes, hasMore } = parsed.data;
  bindCursor(from, source);
  bindCursor(next, source);
  if (next.seq - from.seq !== changes.length || (hasMore && changes.length === 0)) {
    throw new ReplicationError("sequence_gap", "复制页内的序号或末尾水位不连续");
  }
  changes.sort((a, b) => a.seq - b.seq);
  for (const [i, change] of changes.entries()) {
    bindCursor(change, source);
    if (change.seq !== from.seq + i + 1) {
      throw new ReplicationError("sequence_gap", "复制页内的序号重复或有空洞");
    }
    if (change.kind === "relay_grant") {
      const { row } = replicaAdapters.relay_grant.decode(change.row);
      if (row.sourceGeneration !== source.generation || row.sourceSeq !== change.seq) {
        throw new ReplicationError("invalid_record", "转告授权绑定的来源日志与页面不符");
      }
    }
  }
  try {
    return db.transaction((tx) => {
      assertRemoteScope(tx, source);
      const current = getPeerCursor(tx, source.sourceHostId);
      if (current) {
        bindCursor(current, source);
      }
      const acknowledged = current?.seq ?? 0;
      if (from.seq > acknowledged) {
        throw new ReplicationError("sequence_gap", "必须先提交缺失的增量或安装快照水位");
      }
      const pending = changes.filter((change) => {
        if (change.seq <= acknowledged) {
          adapterFor(change.kind).decode(change.row);
          return false;
        }
        return true;
      });
      const applied = applyReplicaBatch(pending, current, ({ kind, row }) => adapterFor(kind).apply(tx, source, row));
      const cursor = current && acknowledged >= next.seq ? current : next;
      if (cursor !== current) {
        writePeerCursor(tx, source, cursor);
      }
      return { status: "applied", cursor, applied };
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof PageWaitingError) {
      return error.result;
    }
    throw error;
  }
}
