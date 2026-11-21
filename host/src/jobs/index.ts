import type { z } from "zod";
import type { Component, HostContext } from "../runtime/index.ts";
import { claimJob, completeJob, enqueueJob, failJob } from "../store/jobs.ts";
import type { EnqueueJob, Job } from "../store/jobs.ts";

export interface JobContext extends HostContext {
  job: Job;
  signal: AbortSignal;
}

export interface QueueOptions<T> {
  schema: z.ZodType<T>;
  handler(payload: T, ctx: JobContext): void | Promise<void>;
  concurrency: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoff?: (attempts: number) => number;
}

interface Queue {
  schema: z.ZodType;
  handler(payload: unknown, ctx: JobContext): void | Promise<void>;
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  backoff: (attempts: number) => number;
}

interface Session {
  ctx: HostContext;
  accepting: boolean;
  writable: boolean;
  work: Map<string, Set<Promise<void>>>;
  cancel: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  unsubscribe?: () => void;
  stopping?: Promise<void>;
}

function positiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("队列配置必须是正整数");
  }
}

export class JobRunner implements Component {
  readonly name = "jobs";
  private readonly queues = new Map<string, Queue>();
  private session: Session | undefined;
  private readonly pollIntervalMs: number;
  private readonly graceMs: number;

  constructor(options: { pollIntervalMs?: number; graceMs?: number } = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.graceMs = options.graceMs ?? 5000;
    positiveInteger(this.pollIntervalMs);
    if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 0) {
      throw new RangeError("停止宽限必须是非负整数");
    }
  }

  register<T>(queue: string, options: QueueOptions<T>): void {
    if (this.session || !queue || this.queues.has(queue)) {
      throw new Error("队列须在启动前注册且不可重复");
    }
    const timeoutMs = options.timeoutMs ?? (queue === "errand" ? 660_000 : 300_000);
    const maxAttempts = options.maxAttempts ?? 3;
    positiveInteger(options.concurrency);
    positiveInteger(timeoutMs);
    positiveInteger(maxAttempts);
    this.queues.set(queue, {
      schema: options.schema,
      handler: (payload, ctx) => options.handler(payload as T, ctx),
      concurrency: options.concurrency,
      timeoutMs,
      maxAttempts,
      backoff: options.backoff ?? ((attempts) => Math.min(1000 * 2 ** (attempts - 1), 60_000)),
    });
  }

  start(ctx: HostContext): void {
    if (this.session) {
      throw new Error("作业运行器已启动");
    }
    const session: Session = {
      ctx,
      accepting: true,
      writable: true,
      work: new Map(),
      cancel: new Set(),
    };
    this.session = session;
    session.unsubscribe = ctx.bus.subscribe("jobs:wake", ({ queue }) => this.pump(session, queue));
    session.timer = setInterval(() => {
      for (const queue of this.queues.keys()) {
        this.pump(session, queue);
      }
    }, this.pollIntervalMs);
    for (const queue of this.queues.keys()) {
      this.pump(session, queue);
    }
  }

  enqueue(queue: string, payload: unknown, options: Omit<EnqueueJob, "queue" | "payload"> = {}): string {
    const session = this.session;
    const registration = this.queues.get(queue);
    if (!session?.accepting || !registration) {
      throw new Error("运行器未启动或队列未注册");
    }
    const id = enqueueJob(session.ctx.store.db, session.ctx.clock, {
      ...options,
      queue,
      payload,
      maxAttempts: options.maxAttempts ?? registration.maxAttempts,
    });
    session.ctx.bus.publish("jobs:wake", { queue });
    return id;
  }

  stop(): Promise<void> {
    const session = this.session;
    if (!session) {
      return Promise.resolve();
    }
    session.accepting = false;
    clearInterval(session.timer);
    session.unsubscribe?.();
    session.stopping ??= this.drain(session);
    return session.stopping;
  }

  private async drain(session: Session): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = [...session.work.values()].flatMap((tasks) => [...tasks]);
      await Promise.race([
        Promise.all(work),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.graceMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      session.writable = false;
      for (const cancel of session.cancel) {
        cancel();
      }
      this.session = undefined;
    }
  }

  private pump(session: Session, queue: string): void {
    const registration = this.queues.get(queue);
    if (!session.accepting || !registration) {
      return;
    }
    let work = session.work.get(queue);
    if (!work) {
      work = new Set();
      session.work.set(queue, work);
    }
    try {
      while (session.accepting && work.size < registration.concurrency) {
        const job = claimJob(session.ctx.store.db, session.ctx.clock, queue, registration.timeoutMs);
        if (!job) {
          break;
        }
        const task = this.execute(session, registration, job)
          .catch((error: unknown) => this.report(session, error))
          .finally(() => {
            work.delete(task);
            this.pump(session, queue);
          });
        work.add(task);
      }
    } catch (error) {
      this.report(session, error);
    }
  }

  private async execute(session: Session, queue: Queue, job: Job): Promise<void> {
    const { ctx } = session;
    let payload: unknown;
    try {
      payload = queue.schema.parse(JSON.parse(job.payload));
    } catch (error) {
      failJob(ctx.store.db, ctx.clock, job, error, ctx.clock.wallMs(), true);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const interrupted = new Promise<{ kind: "timeout" | "cancelled" }>((resolve) => {
      cancel = () => {
        resolve({ kind: "cancelled" });
        controller.abort();
      };
      timer = setTimeout(() => {
        resolve({ kind: "timeout" });
        controller.abort();
      }, queue.timeoutMs);
    });
    session.cancel.add(cancel);
    const result = Promise.resolve()
      .then(() => queue.handler(payload, { ...ctx, job, signal: controller.signal }))
      .then(() => ({ kind: "done" as const }), (error: unknown) => ({ kind: "failed" as const, error }));
    try {
      const outcome = await Promise.race([result, interrupted]);
      if (!session.writable || outcome.kind === "timeout" || outcome.kind === "cancelled") {
        return;
      }
      if (outcome.kind === "done") {
        completeJob(ctx.store.db, ctx.clock, job);
      } else if (outcome.kind === "failed") {
        const delay = queue.backoff(job.attempts);
        if (!Number.isSafeInteger(delay) || delay < 0) {
          throw new RangeError("重试退避必须是非负整数毫秒");
        }
        failJob(ctx.store.db, ctx.clock, job, outcome.error, ctx.clock.wallMs() + delay);
      }
    } finally {
      clearTimeout(timer);
      session.cancel.delete(cancel);
    }
  }

  private report(session: Session, error: unknown): void {
    try {
      const result = session.ctx.config.onError
        ? session.ctx.config.onError(error, "jobs")
        : console.error("作业运行器错误", error);
      Promise.resolve(result).catch(() => {});
    } catch {}
  }
}
