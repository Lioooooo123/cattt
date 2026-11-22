import { inArray } from "drizzle-orm";
import { listAllowedDiaryEntries } from "./diary.ts";
import { readVerifiedFileDescription } from "./file-descriptions.ts";
import type { StoreDb } from "./index.ts";
import { listRecallMemories } from "./knowledge.ts";
import { readKnowledgeSource } from "./knowledge-source.ts";
import { chatReplyKnowledge } from "./schema/memory-extraction.ts";
import type { RecallEvidence } from "./schema/memory-extraction.ts";

type Reader = Pick<StoreDb, "select">;
export type KnowledgeEvidence = RecallEvidence;
export type { RecallEvidence };

export function readKnowledgeEvidenceText(db: Reader, householdId: string, item: KnowledgeEvidence): string | undefined {
  switch (item.kind) {
    case "message":
      return readKnowledgeSource(db, { ...item, householdId })?.text;
    case "memory": {
      const memory = listRecallMemories(db, { householdId, id: item.id, rev: item.rev })[0];
      return memory && `${memory.predicate} ${memory.value}`;
    }
    case "diary":
      return listAllowedDiaryEntries(db, { householdId, id: item.id, rev: item.rev })[0]?.text;
    case "file_description":
      return readVerifiedFileDescription(db, { fileId: item.id, fileRev: item.rev }, householdId)?.text;
  }
}

export function readReplyKnowledge(db: Reader, ids: readonly string[]) {
  if (!ids.length) { return new Map<string, RecallEvidence[]>(); }
  const table = chatReplyKnowledge;
  return new Map(db.select().from(table).where(inArray(table.messageId, ids)).all()
    .map(({ messageId, references }) => [messageId, references]));
}

export function saveReplyKnowledge(db: Pick<StoreDb, "insert">, messageId: string, references: RecallEvidence[]) {
  if (references.length) {
    db.insert(chatReplyKnowledge).values({ messageId, references }).run();
  }
}
