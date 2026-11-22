import type { JobContext, JobResult, JobRunner } from "../jobs/index.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import {
  assertExecution, assertExecutionPermission, commitWorkerResult, discardExecution,
  ExecutionPermissionChanged, ExecutionPublicationPending, ExecutionStopped, readConversationHead,
} from "../store/ticket-worker.ts";
import type { ExecutionFence, WorkerReport } from "../store/ticket-worker.ts";
import { admitNextErrand } from "../tickets/index.ts";
import { errandJobSchema, followupJobSchema } from "../tickets/types.ts";
import type { TicketJob } from "../tickets/types.ts";
import { computeInWorker } from "../ticket-worker-isolation.ts";
import { executeErrand } from "./errand.ts";
import type { TicketWorkerServices } from "./types.ts";

async function execute(ctx: JobContext, payload: TicketJob, services: TicketWorkerServices, exhausted = false): Promise<JobResult> {
  const db = ctx.store.db;
  const fence: ExecutionFence = {
    attempt: ctx.job, payload, clock: ctx.clock, policy: ctx.config.ticketAdmission,
    groupAuthority: ctx.config.groupPublicationAuthority, publication: ctx.publication,
    context: ctx.config.ticketWorkerContext ?? services.context,
  };
  let report: WorkerReport | undefined;
  try {
    ctx.signal.throwIfAborted();
    if (payload.kind === "errand") {
      report = await executeErrand(ctx, fence, { ...services, context: fence.context }, exhausted);
    } else {
      const { ticket } = assertExecution(db, fence);
      assertExecutionPermission(db, fence, ticket);
      if (exhausted) {
        report = commitWorkerResult(db, fence, {
          result: { status: "failed", reason: "这次没能处理约定。" },
          head: readConversationHead(db, ticket, fence.clock, fence.groupAuthority, fence.publication), dependencies: [],
        });
      } else {
        const dueAt = ticket.dueAt!;
        const timeZone = ticket.timeZone;
        const head = readConversationHead(db, ticket, fence.clock, fence.groupAuthority, fence.publication);
        const plan = await computeInWorker({
          kind: "followup", timing: { dueAt, now: ctx.clock.wallMs(), timeZone },
        }, ctx.signal);
        ctx.signal.throwIfAborted();
        if ("deferUntil" in plan) {
          return plan;
        }
        report = commitWorkerResult(db, fence, {
          result: { status: "due", about: ticket.goal, delivery: plan.delivery }, head, dependencies: [],
        });
      }
    }
  } catch (error) {
    if (ctx.signal.aborted || error instanceof ExecutionStopped) {
      return;
    }
    if (error instanceof ExecutionPublicationPending) return { deferUntil: ctx.clock.wallMs() + 2000 };
    if (!(error instanceof ExecutionPermissionChanged)) {
      throw error;
    }
    try {
      discardExecution(db, fence);
    } catch (stale) {
      if (stale instanceof ExecutionPublicationPending) return { deferUntil: ctx.clock.wallMs() + 2000 };
      if (!(stale instanceof ExecutionStopped)) {
        throw stale;
      }
    }
  }

  if (report) {
    ctx.bus.publish("worker:report", { reportId: report.id });
  }
}

export function registerTicketWorkers(runner: JobRunner, services: TicketWorkerServices = {}): void {
  runner.register("errand", {
    schema: errandJobSchema, concurrency: 2, leaseMs: 45_000, timeoutMs: 660_000,
    handler: (payload, ctx) => execute(ctx, payload, services),
    onExhausted: async (payload, ctx) => { await execute(ctx, payload, services, true); },
  });
  runner.register("followup", {
    schema: followupJobSchema, concurrency: 1, leaseMs: 45_000, timeoutMs: 60_000,
    handler: (payload, ctx) => execute(ctx, payload, services),
    onExhausted: async (payload, ctx) => { await execute(ctx, payload, services, true); },
  });
}

/** 队列转正读取持久事项。重启、丢唤醒及当地跨日都会重新扫描。 */
export class TicketQueueAdmission implements Component {
  readonly name = "ticket-admission";
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;

  constructor(private readonly intervalMs = 1000) {}

  start(ctx: HostContext): void {
    const scan = () => {
      try {
        while (admitNextErrand(ctx)) {
          // 扫到两件在办或成员日限额后自然停止。
        }
      } catch (error) {
        if (ctx.config.onError) {
          void Promise.resolve(ctx.config.onError(error, this.name)).catch(() => {});
        } else {
          console.error("排队托付扫描失败", error);
        }
      }
    };
    this.unsubscribe = ctx.bus.subscribe("worker:report", scan);
    this.timer = setInterval(scan, this.intervalMs);
    scan();
  }

  stop(): void {
    clearInterval(this.timer);
    this.unsubscribe?.();
  }
}
