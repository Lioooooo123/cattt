import { z } from "zod";
import type { Actor } from "../identity/index.ts";
import type { StoreDb } from "../store/index.ts";

const topic = z.string().trim().min(1).refine((value) => [...value].length <= 60);
const supplement = z.string().trim().min(1).refine((value) => [...value].length <= 2000);
const time = z.string().min(1).max(40);
const ticketId = z.uuid();

export const scheduleFields = z.strictObject({ when: time, about: topic });
export const errandFields = z.strictObject({ goal: topic });
export const patchTicketFields = z.union([
  z.strictObject({ when: time }), z.strictObject({ text: supplement }),
]);

export const ticketCommandSchema = z.discriminatedUnion("kind", [
  scheduleFields.extend({ kind: z.literal("schedule") }),
  errandFields.extend({ kind: z.literal("start") }),
  z.strictObject({ kind: z.literal("reschedule"), ticketId, when: time }),
  z.strictObject({ kind: z.literal("append"), ticketId, text: supplement }),
  z.strictObject({ kind: z.literal("cancel"), ticketId }),
]);

export type TicketCommand = z.infer<typeof ticketCommandSchema>;

export interface SourceReference {
  messageId: string;
  revision: number;
}

/** 原轮次的数据来自设备或 peer Inbox 准入后的持久消息。 */
export interface TicketChatSource extends SourceReference {
  actor: Actor;
  original: boolean;
  retryActor?: Actor;
}

export type CommandOrigin =
  | ({ source: "chat" } & SourceReference)
  | { source: "app"; requestId?: string; proof?: SourceReference };

export interface TicketCommandContext {
  actor: Actor;
  conversationId?: string;
  origin: CommandOrigin;
  assertChatTurn?: (db: Pick<StoreDb, "select" | "transaction">) => void;
}

export interface SourceProof {
  householdId: string;
  sourceMemberId: string;
  sourceMessageId: string;
  sourceRevision: number;
}

export interface TicketAdmissionPolicy {
  /** 在准入事务中读取当前许可。R4 可直接提供 readKnowledgeSource。 */
  readKnowledgeSource?: (db: Pick<StoreDb, "select">, proof: SourceProof) => { id: string } | undefined;
  allowsTopic?: (db: Pick<StoreDb, "select">, input: {
    householdId: string;
    memberId: string;
    conversationId: string;
    text: string;
  }) => boolean;
  timeZone?: (db: Pick<StoreDb, "select">, actor: Actor) => string | undefined;
  /** Router 没有设备 Actor，按成员读取当前安静时段的时区。 */
  publicationTimeZone?: (
    db: Pick<StoreDb, "select">, member: Pick<Actor, "householdId" | "memberId" | "hostId">,
  ) => string | undefined;
}

export const ticketStatuses = ["open", "ended", "all", "actionable"] as const;
export type TicketStatusFilter = typeof ticketStatuses[number];
const ticketJobIdentity = { ticketId, ticketRev: z.number().int().positive() };
export const followupJobSchema = z.strictObject({ kind: z.literal("followup"), ...ticketJobIdentity });
export const errandJobSchema = z.strictObject({
  kind: z.literal("errand"), ...ticketJobIdentity, runId: z.uuid(), generation: z.number().int().nonnegative(),
});
export type TicketJob = z.infer<typeof followupJobSchema> | z.infer<typeof errandJobSchema>;

export const ERRAND_BUDGET = { steps: 20, outputTokens: 8000, elapsedMs: 600_000 } as const;

export class TicketError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: "invalid_request" | "not_found" | "source_unavailable"
      | "not_publisher" | "idempotency_conflict" | "permission_denied" | "not_actionable",
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
  }
}
