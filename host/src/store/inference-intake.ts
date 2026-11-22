import { assessKnowledgeUse } from "../context/policy.ts";
import { defaultAskOutcomeRule, outcomeEvent } from "../inference/rules.ts";
import type { AskOutcomeRule } from "../inference/rules.ts";
import type { StoreDb } from "./index.ts";
import { readProactivePermission } from "./proactive-permission.ts";
import type { messages } from "./schema/conversations.ts";
import { inferenceCandidates } from "./schema/inference.ts";

export function admitInference(
  db: Pick<StoreDb, "select" | "insert">, row: typeof messages.$inferSelect,
  scope: { householdId: string; participantMemberIds: string[] }, publicationEpoch: string,
  rule: AskOutcomeRule = defaultAskOutcomeRule,
): boolean {
  if (!row.authorMemberId || rule.mode === "off" || !scope.participantMemberIds.includes(row.authorMemberId)) {
    return false;
  }
  const permissions = scope.participantMemberIds.map((id) => readProactivePermission(db, id));
  const author = permissions.find(({ memberId }) => memberId === row.authorMemberId)!;
  if (permissions.some(({ allowed }) => !allowed)) { return false; }
  const event = outcomeEvent(row.text, row.createdAt, author.timeZone);
  if (!event || assessKnowledgeUse(db, {
    householdId: scope.householdId, audienceMemberIds: scope.participantMemberIds,
    evidence: [{ kind: "message", sourceMemberId: row.authorMemberId, sourceMessageId: row.id, sourceRevision: row.rev }],
  }) !== "allowed") {
    return false;
  }
  db.insert(inferenceCandidates).values({
    sourceMessageId: row.id, sourceRevision: row.rev, householdId: scope.householdId,
    conversationId: row.conversationId, sourceMemberId: row.authorMemberId, hostId: row.originHostId,
    audience: permissions.map(({ memberId, revision }) => ({ memberId, revision })),
    publicationEpoch, sourceTimeZone: author.timeZone, rule, topic: event.topic, afterAt: event.afterAt,
    status: "pending", retryAt: Math.max(row.createdAt, event.afterAt),
  }).run();
  return true;
}
