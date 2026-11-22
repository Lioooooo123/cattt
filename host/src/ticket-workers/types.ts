import { z } from "zod";
import type { SummarizeToolHistory } from "../llm/tool-history-summary.ts";
import type { ToolMessage, ToolModel } from "../llm/tool-loop.ts";
import type { StoreDb } from "../store/index.ts";
import type { TicketRow } from "../store/tickets.ts";

const line = z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/.test(value));

export const errandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("progress") }),
  z.strictObject({ status: z.literal("waiting"), question: line }),
  z.strictObject({ status: z.literal("ready"), result: z.string().trim().min(1).max(600) }),
  z.strictObject({ status: z.literal("blocked"), reason: line }),
  z.strictObject({ status: z.literal("failed"), reason: line }),
  z.strictObject({ status: z.literal("dropped") }),
]);

export type ErrandResult = z.infer<typeof errandResultSchema>;
export type WorkerResult = Exclude<ErrandResult, { status: "progress" }> | {
  status: "due";
  about: string;
  delivery: "scheduled" | "mailbox_only";
};

export type WorkerDependency = {
  kind: "message" | "memory" | "diary" | "context";
  id: string;
  revision: number;
  memberId?: string;
};

export type ConversationHead = {
  revision: number;
  publicationEpoch?: string;
  latestMessage: { id: string; revision: number } | null;
};

export type WorkerToolResult = { value: unknown; dependencies?: readonly WorkerDependency[] };
type WorkerReader = Pick<StoreDb, "select">;

export interface WorkerTool {
  description: string;
  schema: z.ZodType;
  read(input: unknown, access: { signal: AbortSignal; guard(): void }): WorkerToolResult | Promise<WorkerToolResult>;
}

export interface TicketWorkerContext {
  /** 每步重装当前事项的共享上下文。每份外部事实都附可复核的来源修订。 */
  prepare(db: WorkerReader, ticket: TicketRow): {
    system?: string;
    messages?: ToolMessage[];
    dependencies?: readonly WorkerDependency[];
    tools?: Record<string, WorkerTool>;
  };
  /** 同步且可在写事务内复核。失效的历史观察不能再进入模型。 */
  permits(db: WorkerReader, ticket: TicketRow, dependencies: readonly WorkerDependency[]): boolean;

}

export interface TicketWorkerServices {
  /** 由 host/src/llm 装配的 worker 槽位，包含供应商准入及宿主级记账。 */
  model?: ToolModel;
  context?: TicketWorkerContext;
  /** 使用同一 worker 槽位的非流式摘要服务，独立记录 context_summary 用量。 */
  summarize?: SummarizeToolHistory;
  retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
}
