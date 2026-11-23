import { ChatEvents } from "../chat-events/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import { acquireLease, assertLeaseHeld, LeaseLostError, releaseLease, renewLease } from "../store/leases.ts";
import { active } from "../store/turn-writes.ts";
import { appendDelta, assertTurnPublication, claimTurn, finishTurn, getTurnRow, heartbeatTurn, queuedTurns, recoverTurns, turnInput } from "../store/turns.ts";
import type { TurnFence } from "../store/turns.ts";
import type { StoreDb } from "../store/index.ts";
import { PublicationLeaseError } from "../publication/types.ts";
import { ConversationNotFoundError } from "../store/conversations.ts";
import { takeYardChatTurn } from "./yard-chat.ts";
import { configuredReplier } from "./chat-replier.ts";
import { batchReplyDeltas } from "./reply-deltas.ts";
import type { Replier, ReplyPublicationGuard } from "./types.ts";
import { ModelReplyError } from "../llm/errors.ts";

interface RunnerOptions {
  budgetMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  staleMs?: number;
  historyLimit?: number;
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
    new ChatEvents(ctx).write((db, append) => recoverTurns(db, ctx.clock, this.options.staleMs, true, append, ctx.publication, ctx.config.groupPublicationAuthority));
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
    events.write((db, append) => recoverTurns(db, ctx.clock, this.options.staleMs, false, append, ctx.publication, ctx.config.groupPublicationAuthority));
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
      if (!claimTurn(ctx.store.db, ctx.clock, row.id, fence, ctx.publication, ctx.config.groupPublicationAuthority)) {
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
    let guard: ReplyPublicationGuard | undefined;
    const budget = setTimeout(() => { failure = "budget_exceeded"; abort.abort(new Error(failure)); }, this.options.budgetMs);
    const heartbeat = setInterval(() => {
      try {
        if (!renewLease(ctx.store.db, ctx.clock, fence.name, fence.holder, fence.epoch, this.options.leaseTtlMs)) {
          abort.abort(new LeaseLostError(fence.name, fence.holder, fence.epoch));
        } else if (!heartbeatTurn(ctx.store.db, ctx.clock, id, fence, ctx.publication, ctx.config.groupPublicationAuthority)) {
          abort.abort(new Error("turn_changed"));
        }
      } catch (error) {
        abort.abort(error);
      }
    }, this.options.heartbeatMs);
    const turn = getTurnRow(ctx.store.db, id)!;
    const yardTurn = takeYardChatTurn(ctx, id);
    const assertPublisher = (db: Pick<StoreDb, "select">) => {
      assertTurnPublication(db, ctx.clock, turn, ctx.publication, ctx.config.groupPublicationAuthority);
    };
    try {
      abort.signal.throwIfAborted();
      const finish = (status: "completed" | "stopped" | "failed") => events.write((db, append) => {
        assertPublisher(db);
        guard?.check(db);
        return finishTurn(db, ctx.clock, id, { status, errorCode: "empty_reply", fence, knowledgeEvidence: guard?.knowledgeEvidence }, append, ctx.publication, ctx.config.groupPublicationAuthority);
      });
      let sourceRevision: number | undefined;
      for (let attempt = 0; ; attempt++) {
        guard = undefined;
        assertPublisher(ctx.store.db);
        const input = turnInput(ctx.store.db, id, this.options.historyLimit);
        sourceRevision ??= input.ticketSource.revision;
        if (input.conversation.publisher_host_id !== ctx.hostId || input.ticketSource.revision !== sourceRevision) {
          throw new ConversationNotFoundError();
        }
        const attemptAbort = new AbortController();
        const signal = AbortSignal.any([abort.signal, attemptAbort.signal]);
        const iterator = this.replier!.reply({
          ...input, turnId: id, yardTurn, signal,
          ticketSource: { ...input.ticketSource, retryActor: yardTurn?.sourceId === input.trigger.id ? yardTurn.actor : undefined },
          assertCurrentTurn(db) {
            signal.throwIfAborted();
            assertLeaseHeld(db, ctx.clock, fence.name, fence.holder, fence.epoch);
            const current = getTurnRow(db, id);
            if (current?.status !== "generating" || current.cancelReason !== null
              || current.triggerMessageId !== turn.triggerMessageId) throw new ConversationNotFoundError();
            assertPublisher(db);
            guard?.check(db);
          },
          assertPublication: () => assertPublisher(ctx.store.db), beforePublish: (check) => { guard = check; },
        })[Symbol.asyncIterator]();
        let drained = false;
        try {
          for await (const text of batchReplyDeltas(iterator, signal)) {
            signal.throwIfAborted();
            const applied = events.write((db, append) => {
              assertPublisher(db);
              guard?.check(db);
              return appendDelta(db, ctx.clock, id, text, fence, append, ctx.publication, ctx.config.groupPublicationAuthority);
            });
            if (!applied) {
              finish("stopped");
              return;
            }
          }
          drained = true;
          const row = getTurnRow(ctx.store.db, id)!;
          finish(row.draftText.length ? "completed" : "failed");
          return;
        } catch (error) {
          const row = getTurnRow(ctx.store.db, id);
          // A concurrent extraction can replace a fact while the first model call is in flight.
          if (!(error instanceof ConversationNotFoundError) || !guard || attempt !== 0 || abort.signal.aborted
            || !row || !active(row) || row.firstTokenAt !== null || row.cancelReason !== null) {
            throw error;
          }
        } finally {
          if (!drained) { attemptAbort.abort(); }
          try { void iterator.return?.().catch(() => {}); } catch {}
        }
      }
    } catch (error) {
      if (!(error instanceof LeaseLostError) && !(abort.signal.reason instanceof LeaseLostError)
        && !(error instanceof PublicationLeaseError) && !(abort.signal.reason instanceof PublicationLeaseError)) {
        events.write((db, append) => {
          const current = getTurnRow(db, id);
          if (!current || !active(current)) return;
          // Cancellation can preserve the visible prefix. Recheck its inputs before that write as well.
          let unavailable = error instanceof ConversationNotFoundError;
          try {
            assertPublisher(db);
            guard?.check(db);
          } catch (guardError) {
            if (guardError instanceof PublicationLeaseError) return;
            if (!(guardError instanceof ConversationNotFoundError)) { throw guardError; }
            unavailable = true;
          }
          return finishTurn(db, ctx.clock, id, {
            status: "failed",
            errorCode: unavailable ? "conversation_unavailable"
              : abort.signal.aborted ? failure : error instanceof ModelReplyError ? error.code : "replier_error",
            fence, knowledgeEvidence: guard?.knowledgeEvidence,
          }, append, ctx.publication, ctx.config.groupPublicationAuthority);
        });
      }
    } finally {
      clearTimeout(budget);
      clearInterval(heartbeat);
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
