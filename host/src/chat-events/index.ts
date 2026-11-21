import type { Component, HostContext } from "../runtime/index.ts";
import {
  getChatStream,
  readChatEvents,
  sweepChatEvents,
  writeChatEvents,
} from "../store/chat-events.ts";
import type { AppendChatEvent, ChatEvent } from "../store/chat-events.ts";
import type { StoreDb } from "../store/index.ts";

export type Subscription =
  | { status: "unknown" }
  | { status: "ok"; events: AsyncGenerator<ChatEvent & { cursor: string }, "end" | "unknown" | "aborted"> };

export class ChatEvents {
  constructor(private readonly ctx: HostContext) {}

  append(input: AppendChatEvent): number {
    return this.write((_db, append) => append(input));
  }

  write<T>(write: (db: StoreDb, append: (input: AppendChatEvent) => number) => T): T {
    const { result, wakes } = writeChatEvents(this.ctx.store, this.ctx.clock, write);
    for (const wake of wakes) {
      this.ctx.bus.publish("chat:event", wake);
    }
    return result;
  }

  cursor(seq: number): string {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new RangeError("游标序号必须是正整数");
    }
    return `${this.ctx.hostId}.${seq}`;
  }

  subscribe(streamId: string, cursor?: string | null, signal?: AbortSignal): Subscription {
    let afterSeq = 0;
    if (cursor !== undefined && cursor !== null) {
      const prefix = `${this.ctx.hostId}.`;
      if (!cursor.startsWith(prefix) || !/^[1-9]\d*$/.test(cursor.slice(prefix.length))) {
        return { status: "unknown" };
      }
      afterSeq = Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(afterSeq)) {
        return { status: "unknown" };
      }
    }
    const stream = getChatStream(this.ctx.store.db, this.ctx.clock, streamId);
    if (!stream || afterSeq > stream.seq) {
      return { status: "unknown" };
    }
    return { status: "ok", events: this.tail(streamId, afterSeq, signal) };
  }

  private async *tail(
    streamId: string,
    afterSeq: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent & { cursor: string }, "end" | "unknown" | "aborted"> {
    let wake: (() => void) | undefined;
    let notified = false;
    const unsubscribe = this.ctx.bus.subscribe("chat:event", (event) => {
      if (event.streamId === streamId) {
        notified = true;
        wake?.();
      }
    });
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    let last = afterSeq;
    try {
      while (!signal?.aborted) {
        notified = false;
        const rows = readChatEvents(this.ctx.store.db, this.ctx.clock, streamId, last, 100);
        for (const row of rows) {
          if (signal?.aborted) {
            return "aborted";
          }
          last = row.seq;
          yield { ...row, cursor: this.cursor(row.seq) };
          if (row.terminal) {
            return "end";
          }
        }
        const stream = getChatStream(this.ctx.store.db, this.ctx.clock, streamId);
        if (!stream) {
          return "unknown";
        }
        if (stream.terminal && last >= stream.seq) {
          return "end";
        }
        if (rows.length) {
          continue;
        }
        if (!notified && !signal?.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => wake?.(), 1000);
            wake = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
          });
        }
      }
      return "aborted";
    } finally {
      wake?.();
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class ChatEventSweeper implements Component {
  readonly name = "chat-events-sweeper";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly intervalMs = 60_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError("清扫间隔必须是正整数毫秒");
    }
  }

  start(ctx: HostContext): void {
    if (this.timer !== undefined) {
      throw new Error("事件清扫器已启动");
    }
    this.timer = setInterval(() => {
      try {
        sweepChatEvents(ctx.store.db, ctx.clock);
      } catch (error) {
        try {
          const result = ctx.config.onError
            ? ctx.config.onError(error, this.name)
            : console.error("事件清扫失败", error);
          Promise.resolve(result).catch(() => {});
        } catch {}
      }
    }, this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
