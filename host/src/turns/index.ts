import { ChatEvents } from "../chat-events/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import { acquireLease, LeaseLostError, releaseLease, renewLease } from "../store/leases.ts";
import { active } from "../store/turn-writes.ts";
import { appendDelta, claimTurn, finishTurn, getTurnRow, heartbeatTurn, queuedTurns, recoverTurns, turnInput } from "../store/turns.ts";
import type { TurnFence } from "../store/turns.ts";
import { ConversationNotFoundError } from "../store/conversations.ts";
import { configuredReplier } from "./chat-replier.ts";
import type { Replier } from "./types.ts";
import { ModelReplyError } from "../llm/errors.ts";

interface RunnerOptions {
  budgetMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  staleMs?: number;
  historyLimit?: number;
}

function nextWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class TurnRunner implements Component {
  readonly name = "turn-runner";
  private ctx: HostContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Map<string, { id: string; abort: AbortController; task: Promise<void> }>();
  private unsubscribe: (() => void)[] = [];
  private stopping = false;
  private scheduled = false;
  private holder = "";
  private replier: Replier | undefined;
  private readonly options: Required<RunnerOptions>;

  constructor(options: RunnerOptions = {}) {
    this.options = { budgetMs: 45_000, pollMs: 250, heartbeatMs: 2000, leaseTtlMs: 10_000, staleMs: 60_000, historyLimit: 50, ...options };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError("轮次运行参数须为正整数");
      }
    }
    if (this.options.historyLimit > 100 || this.options.heartbeatMs >= this.options.leaseTtlMs) {
      throw new RangeError("历史上限为 100，心跳须小于租期");
    }
  }

  start(ctx: HostContext): void {
    this.replier = ctx.config.replier ?? configuredReplier(ctx);
    this.ctx = ctx;
    this.stopping = false;
    this.holder = `${ctx.hostId}:${uuidv7(ctx.clock)}`;
    new ChatEvents(ctx).write((db, append) => recoverTurns(db, ctx.clock, this.options.staleMs, true, append));
    this.unsubscribe = [ctx.bus.subscribe("chat:event", () => this.wake()), ctx.bus.subscribe("turn:wake", () => this.wake())];
    this.timer = setInterval(() => this.wake(), this.options.pollMs);
    this.wake();
  }

  private wake(): void {
    if (this.stopping || this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.stopping || !this.ctx) {
        return;
      }
      try {
        this.scan();
      } catch (error) {
        this.report(error);
      }
    });
  }

  private scan(): void {
    const ctx = this.ctx!;
    const events = new ChatEvents(ctx);
    events.write((db, append) => recoverTurns(db, ctx.clock, this.options.staleMs, false, append));
    for (const task of this.running.values()) {
      const row = getTurnRow(ctx.store.db, task.id);
      if (!row || !active(row) || row.cancelReason !== null) {
        task.abort.abort(new Error("turn_changed"));
      }
    }
    for (const row of queuedTurns(ctx.store.db)) {
      if (this.running.has(row.conversationId)) {
        continue;
      }
      const fence = { name: `conversation:${row.conversationId}`, holder: `${this.holder}:${row.id}`, epoch: 0 };
      const lease = acquireLease(ctx.store.db, ctx.clock, { ...fence, ttlMs: this.options.leaseTtlMs });
      if (!lease.acquired) {
        continue;
      }
      fence.epoch = lease.epoch;
      if (!claimTurn(ctx.store.db, ctx.clock, row.id, fence)) {
        releaseLease(ctx.store.db, ctx.clock, fence.name, fence.holder, fence.epoch);
        continue;
      }
      const abort = new AbortController();
      const task = Promise.resolve().then(() => this.run(row.id, fence, abort)).catch((error) => this.report(error)).finally(() => {
        this.running.delete(row.conversationId);
        this.wake();
      });
      this.running.set(row.conversationId, { id: row.id, abort, task });
    }
  }

  private async run(id: string, fence: TurnFence, abort: AbortController): Promise<void> {
    const ctx = this.ctx!;
    const events = new ChatEvents(ctx);
    let failure = "interrupted";
    let iterator: AsyncIterator<string> | undefined;
    const budget = setTimeout(() => { failure = "budget_exceeded"; abort.abort(new Error(failure)); }, this.options.budgetMs);
    const heartbeat = setInterval(() => {
      try {
        if (!renewLease(ctx.store.db, ctx.clock, fence.name, fence.holder, fence.epoch, this.options.leaseTtlMs)) {
          abort.abort(new LeaseLostError(fence.name, fence.holder, fence.epoch));
        } else if (!heartbeatTurn(ctx.store.db, ctx.clock, id, fence)) {
          abort.abort(new Error("turn_changed"));
        }
      } catch (error) {
        abort.abort(error);
      }
    }, this.options.heartbeatMs);
    try {
      abort.signal.throwIfAborted();
      const input = turnInput(ctx.store.db, id, this.options.historyLimit);
      if (input.conversation.publisher_host_id !== ctx.hostId) {
        throw new ConversationNotFoundError();
      }
      iterator = this.replier!.reply({ ...input, signal: abort.signal })[Symbol.asyncIterator]();
      for (;;) {
        abort.signal.throwIfAborted();
        const next = await nextWithAbort(Promise.resolve(iterator.next()), abort.signal);
        abort.signal.throwIfAborted();
        if (next.done) {
          break;
        }
        if (typeof next.value !== "string") {
          throw new TypeError("Replier 必须返回文本块");
        }
        const applied = events.write((db, append) => appendDelta(db, ctx.clock, id, next.value, fence, append));
        if (!applied) {
          events.write((db, append) => finishTurn(db, ctx.clock, id, { status: "stopped", fence }, append));
          return;
        }
      }
      const row = getTurnRow(ctx.store.db, id)!;
      events.write((db, append) => finishTurn(db, ctx.clock, id, {
        status: row.draftText.length ? "completed" : "failed", errorCode: "empty_reply", fence,
      }, append));
    } catch (error) {
      if (!(error instanceof LeaseLostError) && !(abort.signal.reason instanceof LeaseLostError)) {
        events.write((db, append) => finishTurn(db, ctx.clock, id, {
          status: "failed", errorCode: error instanceof ConversationNotFoundError ? "conversation_unavailable" : abort.signal.aborted ? failure : error instanceof ModelReplyError ? error.code : "replier_error", fence,
        }, append));
      }
    } finally {
      clearTimeout(budget);
      clearInterval(heartbeat);
      try {
        void iterator?.return?.().catch(() => {});
      } catch {}
      releaseLease(ctx.store.db, ctx.clock, fence.name, fence.holder, fence.epoch);
    }
  }

  private report(error: unknown): void {
    const ctx = this.ctx;
    try {
      Promise.resolve(ctx?.config.onError ? ctx.config.onError(error, this.name) : console.error("轮次运行失败", error)).catch(() => {});
    } catch {}
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }
    for (const task of this.running.values()) {
      task.abort.abort(new Error("interrupted"));
    }
    await Promise.all([...this.running.values()].map((task) => task.task));
    this.ctx = undefined;
  }
}
