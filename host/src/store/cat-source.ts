import { readKnowledgePolicy } from "../context/policy.ts";
import type { DiarySource } from "../soul/facts.ts";
import type { MessageProof } from "../soul/rules.ts";
import type { CatReader } from "./cat-facts.ts";
import { listAllowedDiaryEntries } from "./diary.ts";
import { importedMemoryPreferences } from "./imported-history.ts";
import { readKnowledgeSource } from "./knowledge-source.ts";
import { listModelVisibleMessages } from "./model-visible-messages.ts";

function catMessage(db: CatReader, householdId: string, message: MessageProof) {
  const row = readKnowledgeSource(db, { ...message, householdId });
  if (!row || !listModelVisibleMessages(db, householdId, row.conversationId, [row.id]).length) return;
  return row;
}

export function diarySourceUse(db: CatReader, householdId: string, memberId: string, source: DiarySource) {
  if (source.kind === "message") {
    if (memberId !== source.sourceMemberId || importedMemoryPreferences(db, memberId)?.recallDisabled) return;
    const row = catMessage(db, householdId, source);
    return row && { text: row.text, datedAt: row.createdAt };
  }
  const row = listAllowedDiaryEntries(db, { householdId, ownerMemberId: memberId, id: source.id, rev: source.rev })[0];
  return row && { text: row.text, datedAt: row.recordedAt };
}

export function allowsSoulSource(
  db: CatReader, householdId: string, audience: readonly string[], source: MessageProof, text: string,
) {
  const row = catMessage(db, householdId, source);
  if (!row) return false;
  const current = audience.includes(source.sourceMemberId) ? audience : [...audience, source.sourceMemberId];
  const policy = readKnowledgePolicy(db, householdId, current);
  return !policy.boundaries.some(({ sourceMessageId }) => sourceMessageId === row.id)
    && !policy.avoids(text) && !policy.avoids(row.text);
}
