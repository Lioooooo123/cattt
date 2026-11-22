import type { Actor } from "../identity/index.ts";
import { canReadConversation } from "../store/conversations.ts";
import type { DiaryEntry } from "../store/diary.ts";
import type { StoreDb } from "../store/index.ts";
import { canManageMemory } from "../store/knowledge.ts";
import type { Boundary, Memory } from "../store/knowledge.ts";
import { readKnowledgeSource } from "../store/knowledge-source.ts";
import type { KnowledgeSource } from "../store/knowledge-source.ts";

type Reader = Pick<StoreDb, "select">;

function resourceRevision(row: { id: string; rev: number }) {
  return { id: row.id, revision: row.rev };
}

function sourceDto(db: Reader, actor: Actor, source: KnowledgeSource, conversationId: string | undefined) {
  if (!conversationId || !canReadConversation(db, actor, conversationId)) {
    return null;
  }
  return {
    member_id: source.sourceMemberId,
    conversation_id: conversationId,
    message_id: source.sourceMessageId,
    revision: source.sourceRevision,
  };
}

export function canViewMemory(actor: Actor, row: Memory) {
  return row.householdId === actor.householdId
    && (row.subjectMemberId === null || row.subjectMemberId === actor.memberId);
}

/** 调用方先使用仓储筛选可用行，墓碑只投影标识和版本。 */
export function projectMemory(db: Reader, actor: Actor, row: Memory) {
  if (!canViewMemory(actor, row)) {
    return undefined;
  }
  const version = resourceRevision(row);
  if (row.deletedAt !== null) {
    return { ...version, deleted_at: row.deletedAt };
  }
  return {
    ...version,
    deleted_at: null,
    subject_member_id: row.subjectMemberId,
    predicate: row.predicate,
    value: row.value,
    source: sourceDto(db, actor, row, readKnowledgeSource(db, row)?.conversationId),
    can_edit: canManageMemory(actor, row),
    updated_at: row.updatedAt,
  };
}

export function projectBoundary(db: Reader, actor: Actor, row: Boundary) {
  if (row.householdId !== actor.householdId || row.subjectMemberId !== actor.memberId) {
    return undefined;
  }
  const version = resourceRevision(row);
  if (row.deletedAt !== null) {
    return { ...version, deleted_at: row.deletedAt };
  }
  return {
    ...version,
    deleted_at: null,
    subject_member_id: row.subjectMemberId,
    description: row.description,
    source: sourceDto(db, actor, row, readKnowledgeSource(db, row)?.conversationId),
    updated_at: row.updatedAt,
  };
}

export function projectDiaryEntry(db: Reader, actor: Actor, row: DiaryEntry) {
  if (row.householdId !== actor.householdId) {
    return undefined;
  }
  const version = resourceRevision(row);
  if (row.deletedAt !== null) {
    return { ...version, deleted_at: row.deletedAt };
  }
  const source = row.sourceMessageId !== null && row.sourceRevision !== null
    ? { ...row, sourceMessageId: row.sourceMessageId, sourceRevision: row.sourceRevision }
    : undefined;
  const message = source && readKnowledgeSource(db, source);
  return {
    ...version,
    deleted_at: null,
    owner_member_id: row.ownerMemberId,
    text: row.text,
    recorded_at: row.recordedAt,
    local_day: row.localDay,
    time_zone: row.timeZone,
    cat_allowed: row.catAllowed,
    cat_readable: row.catAllowed && (source === undefined || message !== undefined),
    source: source ? sourceDto(db, actor, source, message?.conversationId) : null,
    can_edit: row.ownerMemberId === actor.memberId,
    updated_at: row.updatedAt,
  };
}
