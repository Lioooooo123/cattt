import { validateToolResponse } from "../llm/tool-loop.ts";
import type { ToolResponse } from "../llm/tool-loop.ts";
import { availableAt } from "../tickets/time.ts";

type FollowupTime = { dueAt: number; now: number; timeZone: string };
type FollowupPlan = { deferUntil: number } | { delivery: "scheduled" | "mailbox_only" };

const dayMs = 86_400_000;

function followupPlan({ dueAt, now, timeZone }: FollowupTime): FollowupPlan {
  if (now < dueAt) {
    return { deferUntil: dueAt };
  }
  const overdueAt = dueAt + dayMs + 1;
  if (now >= overdueAt) {
    return { delivery: "mailbox_only" };
  }
  const publicationAt = availableAt(now, timeZone);
  return publicationAt === now ? { delivery: "scheduled" } : { deferUntil: Math.min(publicationAt, overdueAt) };
}

export type ComputeRequest =
  | { kind: "model"; response: ToolResponse; previousIds: string[] }
  | { kind: "followup"; timing: FollowupTime };
export type ComputeResult<Request extends ComputeRequest = ComputeRequest> =
  Request extends { kind: "model" } ? ToolResponse : FollowupPlan;

export function compute(request: ComputeRequest): ComputeResult {
  return request.kind === "followup"
    ? followupPlan(request.timing)
    : validateToolResponse(request.response, request.previousIds);
}
