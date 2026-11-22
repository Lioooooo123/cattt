import { createPublicationPush } from "../push/index.ts";
import { assessOutcome } from "../inference/assessment.ts";
import { dueInference, finalizeInference, prepareInference } from "../store/inference.ts";
import type { PublicationPushAdapter } from "./types.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import { claimNextPublicationPush, recoverInterruptedPush, settlePublicationPush } from "../store/publication-push.ts";
import { discoverReports, duePublications, publicationBatch, publishReport } from "../store/report-publications.ts";

export class ReportRouter implements Component {
  readonly name = "report-router";
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe: (() => void)[] = [];
  private abort?: AbortController;
  private assessing?: Promise<void>;
  private delivering?: Promise<void>;
  private relaying?: Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(options: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new RangeError("汇报扫描间隔必须是正整数毫秒");
    }
  }

  start(ctx: HostContext): void {
    ctx.config.publicationPush ??= createPublicationPush(ctx);
    const abort = new AbortController();
    this.abort = abort;
    const model = ctx.config.model && ctx.models.slot("router").model ? ctx.models.text("route") : undefined;
    const reportError = (error: unknown) => {
      if (ctx.config.onError) {
        void Promise.resolve().then(() => ctx.config.onError!(error, this.name)).catch(() => {});
      } else {
        console.error("团子汇报处理失败", error);
      }
    };
    const scan = () => {
      try {
        discoverReports(ctx);
        for (const id of duePublications(ctx)) {
          try {
            publishReport(ctx, id);
          } catch (error) {
            reportError(error);
          }
        }
        if (ctx.config.relay && !this.relaying && !abort.signal.aborted) {
          const relay = ctx.config.relay;
          this.relaying = relay.publishPending(ctx, abort.signal).catch((error) => {
            if (!abort.signal.aborted) {
              reportError(error);
            }
          }).finally(() => { this.relaying = undefined; });
        }
        if (model && !this.assessing) {
          const due = dueInference(ctx);
          if (due.length) {
            this.assessing = Promise.resolve().then(async () => {
              for (const id of due) {
                if (abort.signal.aborted) { break; }
                const snapshot = prepareInference(ctx, id);
                if (!snapshot) { continue; }
                const decision = await assessOutcome(model, snapshot.assessment, abort.signal, () => {
                  const current = prepareInference(ctx, id);
                  if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) {
                    throw new Error("inference_source_changed");
                  }
                });
                if (abort.signal.aborted) { break; }
                finalizeInference(ctx, id, snapshot, decision);
              }
            }).catch((error) => {
              if (!abort.signal.aborted) { reportError(error); }
            }).finally(() => { this.assessing = undefined; });
          }
        }
        if (ctx.config.publicationPush && !this.delivering) {
          // 先运行到一次微任务切换，以便在可能触发外部回调前登记运行状态。
          this.delivering = Promise.resolve().then(async () => {
            for (let index = 0; index < publicationBatch && !abort.signal.aborted; index += 1) {
              const send = ctx.config.publicationPush;
              if (!send) {
                break;
              }
              const intent = claimNextPublicationPush(ctx);
              if (!intent) {
                break;
              }
              // 外部调用不持写事务。中断后留下明确的未知结果，避免将同一通知自动再发一次。
              let result: Awaited<ReturnType<PublicationPushAdapter>>;
              try {
                result = await send(intent, abort.signal);
              } catch {
                result = "uncertain";
              }
              settlePublicationPush(ctx, intent.id, result);
            }
          }).catch(reportError).finally(() => { this.delivering = undefined; });
        }
      } catch (error) {
        reportError(error);
      }
    };
    recoverInterruptedPush(ctx);
    this.unsubscribe = [
      ctx.bus.subscribe("worker:report", scan), ctx.bus.subscribe("inference:wake", scan),
      ctx.bus.subscribe("relay:wake", scan),
    ];
    this.timer = setInterval(scan, this.pollIntervalMs);
    scan();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribe.splice(0)) { unsubscribe(); }
    this.abort?.abort();
    await Promise.all([this.delivering, this.assessing, this.relaying]);
  }
}
