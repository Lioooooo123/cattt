import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../clock/index.ts";
import { readKnowledgePolicy } from "../context/policy.ts";
import type { ConfirmedMemory, ExtractionInput, ExtractionMessage, MemoryExtractionResult } from "../memory/extraction.ts";
import { businessRow } from "./business.ts";
import { importedMemoryPreferences } from "./imported-history.ts";
import { listModelVisibleMessages } from "./model-visible-messages.ts";
import type { ExtractionDependency } from "./knowledge-replicas.ts";
import { getHostMeta } from "./host-meta.ts";
import { listMembers } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { completeJob, enqueueJob } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { saveCorrectedMemory, saveMemory } from "./knowledge.ts";
import { hasKnowledgeSource, readKnowledgeSource } from "./knowledge-source.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { pendingMemoryExtractions } from "./schema/memory-extraction.ts";

export const MEMORY_EXTRACTION_QUEUE = "memory-extraction";
export const memoryExtractionJobSchema = z.strictObject({
  householdId: z.uuid(),
  conversationId: z.uuid(),
  sourceMemberId: z.uuid(),
  sourceMessageId: z.uuid(),
  sourceRevision: z.number().int().positive(),
});

type Source = z.infer<typeof memoryExtractionJobSchema>;
type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "transaction">;
type WriteTransaction = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];
type MessageRow = typeof messages.$inferSelect;
type ContextProof = Pick<MessageRow, "id" | "rev" | "authorMemberId">;
type Scope = Pick<ExtractionInput, "conversation" | "members">;
const HISTORY_LIMIT = 32;

interface Snapshot {
  input: ExtractionInput;
  context: ReadonlyMap<string, ContextProof>;
}

export interface PairMemoryWrite extends Source, Omit<ConfirmedMemory, "subject" | "sourceMemberId" | "sourceMessageId"> {
  subject: { kind: "pair" };
  memberIds: readonly [string, string];
  predicate: string;
  fingerprint: string;
}

/** 同步且幂等地写入一条共同记忆，返回 memories 中的行 ID；屏蔽时返回 undefined。 */
export type PairMemoryWriter = (
  tx: WriteTransaction, clock: Clock, input: PairMemoryWrite, dependencies: readonly ExtractionDependency[],
) => { id: string } | undefined;

function readCurrent(db: Reader, source: Source) {
  if (importedMemoryPreferences(db, source.sourceMemberId)?.learningDisabled) return;
  const message = readKnowledgeSource(db, source);
  return message?.conversationId === source.conversationId && message.originHostId === getHostMeta(db, "host_id")
    && message.text.trim() ? message : undefined;
}

/** 仅限原创发送事务调用。复制、导入与重试回复均不走该入口。 */
export function enqueueMessageExtraction(db: WriteTransaction, clock: Clock, source: Source): void {
  if (!readCurrent(db, source)) {
    return;
  }
  enqueueJob(db, clock, {
    queue: MEMORY_EXTRACTION_QUEUE, payload: source, dedupeKey: `${source.sourceMessageId}:${source.sourceRevision}`,
  });
}

function readScope(db: Reader, source: Source): Scope | undefined {
  const conversation = db.select().from(conversations).where(and(
    eq(conversations.id, source.conversationId),
    eq(conversations.householdId, source.householdId),
    isNull(conversations.deletedAt),
  )).get();
  if (!conversation) {
    return;
  }
  const members = listMembers(db, source.householdId).map(({ id, displayName }) => ({ id, name: displayName }));
  const active = new Set(members.map(({ id }) => id));
  const participantIds = db.select({ id: participants.memberId }).from(participants).where(and(
    eq(participants.conversationId, conversation.id),
    isNull(participants.deletedAt),
  )).all().map(({ id }) => id).filter((id) => active.has(id));
  const eligible = conversation.kind === "direct"
    ? conversation.ownerMemberId === source.sourceMemberId
    : participantIds.includes(source.sourceMemberId);
  if (!eligible || !active.has(source.sourceMemberId)) {
    return;
  }
  return {
    conversation: {
      id: conversation.id, kind: conversation.kind, owner_member_id: conversation.ownerMemberId,
      participant_member_ids: participantIds,
    },
    members,
  };
}

function avoidsForExtraction(db: Reader, source: Source, scope: Scope) {
  const { conversation } = scope;
  return readKnowledgePolicy(db, source.householdId, conversation.kind === "direct"
    ? [source.sourceMemberId] : conversation.participant_member_ids).avoids;
}

function allowedContext(message: MessageRow, scope: Scope, avoids: (text: string) => boolean): boolean {
  const { conversation } = scope;
  const eligibleAuthor = conversation.kind === "direct"
    ? message.authorMemberId === conversation.owner_member_id
    : message.authorMemberId !== null && conversation.participant_member_ids.includes(message.authorMemberId);
  return message.status === "complete" && (message.authorMemberId === null || eligibleAuthor) && !avoids(message.text);
}

function extractionMessage(row: MessageRow, allowed: boolean): ExtractionMessage {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    author: row.authorMemberId === null ? { kind: "cat" } : { kind: "member", member_id: row.authorMemberId },
    status: row.status,
    permission: allowed ? "allowed" : "denied",
    text: allowed ? row.text : "",
  };
}

export function loadMemoryExtraction(db: Writer, source: Source): Snapshot | undefined {
  return db.transaction((tx) => {
    const current = readCurrent(tx, source);
    const scope = current && readScope(tx, source);
    if (!current || !scope) {
      return;
    }
    const avoids = avoidsForExtraction(tx, source, scope);
    if (avoids(current.text)) {
      return;
    }
    const rows = tx.select().from(messages).where(and(
      eq(messages.conversationId, current.conversationId),
      or(lt(messages.hlc, current.hlc), and(eq(messages.hlc, current.hlc), lt(messages.id, current.id))),
    )).orderBy(desc(messages.hlc), desc(messages.id)).limit(HISTORY_LIMIT).all().reverse();
    const visible = new Map(listModelVisibleMessages(tx, source.householdId, source.conversationId,
      rows.map(({ id }) => id)).map((row) => [row.id, row]));
    const context = new Map<string, ContextProof>();
    const history = rows.map((row) => {
      const live = visible.get(row.id);
      // An assistant turn using recalled material cannot establish a new extraction source.
      const allowed = !!live && live.knowledgeEvidence.length === 0 && allowedContext(live, scope, avoids);
      const { id, rev, authorMemberId } = row;
      if (allowed) {
        context.set(id, { id, rev, authorMemberId });
      }
      return extractionMessage(row, allowed);
    });
    return {
      input: { ...scope, current: extractionMessage(current, true), history, learningEnabled: true },
      context,
    };
  });
}

function dependencyProof(
  tx: Reader, source: Source, scope: Scope, snapshot: Snapshot, candidate: ConfirmedMemory,
  avoids: (text: string) => boolean,
): ContextProof[] | undefined {
  const dependencies: ContextProof[] = [];
  const ids = [...new Set(candidate.contextMessageIds)];
  for (const current of listModelVisibleMessages(tx, source.householdId, source.conversationId, ids)) {
    const previous = snapshot.context.get(current.id);
    if (!previous || !allowedContext(current, scope, avoids) || current.rev !== previous.rev
      || current.authorMemberId !== previous.authorMemberId) {
      return;
    }
    dependencies.push(previous);
  }
  if (dependencies.length !== ids.length) {
    return;
  }
  return dependencies;
}

function sameSource(candidate: { sourceMemberId: string; sourceMessageId: string }, source: Source) {
  return candidate.sourceMessageId === source.sourceMessageId && candidate.sourceMemberId === source.sourceMemberId;
}

const writeHouseholdMemory: PairMemoryWriter = (tx, clock, input, dependencies) => {
  const write = input.correction ? saveCorrectedMemory : saveMemory;
  return write(tx, clock, { ...input, subjectMemberId: null }, dependencies);
};

function saveConfirmed(
  tx: WriteTransaction, clock: Clock, source: Source, scope: Scope, snapshot: Snapshot,
  candidate: ConfirmedMemory, writePair: PairMemoryWriter, proof: readonly ExtractionDependency[],
) {
  const { key, value, subject } = candidate;
  const fingerprint = key.normalize("NFKC").toLowerCase().trim();
  if (subject.kind === "member") {
    const write = candidate.correction ? saveCorrectedMemory : saveMemory;
    return write(tx, clock, { ...source, subjectMemberId: subject.memberId, fingerprint, predicate: key, value }, proof);
  }
  const [first, second] = snapshot.input.members;
  if (snapshot.input.members.length !== 2 || scope.members.length !== 2 || !first || !second
    || !scope.members.every(({ id }) => id === first.id || id === second.id)) {
    return;
  }
  return writePair(tx, clock, {
    ...candidate, ...source, subject, memberIds: [first.id, second.id], fingerprint, predicate: key,
  }, proof);
}

/** 作业终态和全部副作用在同一事务内，租约超时或旧代次无法越过 completeJob。 */
export function commitMemoryExtraction(
  db: Writer, clock: Clock, job: Job, source: Source, snapshot: Snapshot,
  result: MemoryExtractionResult, writePair: PairMemoryWriter = writeHouseholdMemory,
): void {
  db.transaction((tx) => {
    if (job.queue !== MEMORY_EXTRACTION_QUEUE || !completeJob(tx, clock, job)) {
      return;
    }
    const current = readCurrent(tx, source);
    const scope = current && readScope(tx, source);
    if (!current || !scope || result.messageId !== current.id || result.status !== "extracted") {
      return;
    }
    const avoids = avoidsForExtraction(tx, source, scope);
    if (avoids(current.text)) {
      return;
    }
    for (const candidate of result.confirmed) {
      if (!sameSource(candidate, source) || avoids(`${candidate.key} ${candidate.value}`)) {
        continue;
      }
      const proof = dependencyProof(tx, source, scope, snapshot, candidate, avoids);
      if (!proof) {
        continue;
      }
      saveConfirmed(tx, clock, source, scope, snapshot, candidate, writePair, proof.map(({ id, rev }) => ({ id, rev })));
    }
    for (const candidate of result.pending) {
      if (sameSource(candidate, source) && !avoids(`${candidate.key} ${candidate.value}`)) {
        tx.insert(pendingMemoryExtractions).values({
          ...businessRow(clock, current.originHostId), ...candidate, householdId: source.householdId,
          sourceRevision: source.sourceRevision,
        }).onConflictDoNothing().run();
      }
    }
  }, { behavior: "immediate" });
}

export function listPendingExtractions(db: Reader, householdId: string) {
  const rows = pendingMemoryExtractions;
  return db.select().from(rows).where(and(
    eq(rows.householdId, householdId), isNull(rows.deletedAt), hasKnowledgeSource(db, rows),
  )).orderBy(asc(rows.id)).all();
}
