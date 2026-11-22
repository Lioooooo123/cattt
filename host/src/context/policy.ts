import type { StoreDb } from "../store/index.ts";
import { listAvailableBoundaries } from "../store/knowledge.ts";
import { readKnowledgeEvidenceText } from "../store/knowledge-use.ts";
import type { KnowledgeEvidence } from "../store/knowledge-use.ts";
import { avoidTopics } from "./relevance.ts";

type Reader = Pick<StoreDb, "select">;

export type { KnowledgeEvidence };

export function readKnowledgePolicy(db: Reader, householdId: string, audienceMemberIds: readonly string[]) {
  const audience = new Set(audienceMemberIds);
  const boundaries = listAvailableBoundaries(db, { householdId })
    .filter(({ subjectMemberId }) => audience.has(subjectMemberId));
  return { boundaries, avoids: avoidTopics(boundaries.map(({ description }) => description)) };
}

/** 调用方先核对目标会话与受众。准入及实际发布时均在调用方事务中复核。 */
export function assessKnowledgeUse(
  db: Reader,
  input: {
    householdId: string;
    audienceMemberIds: readonly string[];
    evidence: readonly KnowledgeEvidence[];
    text?: string;
  },
): "allowed" | "source_unavailable" | "avoided_topic" {
  const { householdId, audienceMemberIds, evidence, text } = input;
  const { avoids } = readKnowledgePolicy(db, householdId, audienceMemberIds);
  const evidenceTexts: string[] = [];
  for (const item of evidence) {
    const value = readKnowledgeEvidenceText(db, householdId, item);
    if (value === undefined) { return "source_unavailable"; }
    evidenceTexts.push(value);
  }
  return (text !== undefined && avoids(text)) || evidenceTexts.some(avoids) ? "avoided_topic" : "allowed";
}
