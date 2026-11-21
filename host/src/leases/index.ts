import type { Component, HostContext } from "../runtime/index.ts";
import {
  acquireLease,
  assertLeaseHeld,
  getLease,
  LeaseLostError,
  releaseLease,
  renewLease,
} from "../store/leases.ts";
import type { LeaseResult } from "../store/leases.ts";

interface HeldLease {
  holder: string;
  epoch: number;
  timer?: ReturnType<typeof setInterval>;
}

export class LeaseKeeper implements Component {
  readonly name = "leases";
  private ctx: HostContext | undefined;
  private readonly held = new Map<string, HeldLease>();

  constructor(private readonly options: { worker?: string; skewMs?: number } = {}) {
    if (options.worker === "" || (options.skewMs !== undefined
      && (!Number.isSafeInteger(options.skewMs) || options.skewMs < 0))) {
      throw new RangeError("工作者名称不能为空，时钟宽限须为非负整数");
    }
  }

  start(ctx: HostContext): void {
    if (this.ctx) {
      throw new Error("租约维护器已启动");
    }
    this.ctx = ctx;
  }

  hold(name: string, options: { ttlMs: number; renewEveryMs: number }): LeaseResult {
    const ctx = this.context();
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1
      || !Number.isSafeInteger(options.renewEveryMs)
      || options.renewEveryMs < 1 || options.renewEveryMs >= options.ttlMs) {
      throw new RangeError("续租间隔必须是小于租期的正整数毫秒");
    }
    if (this.epoch(name) !== undefined) {
      const row = getLease(ctx.store.db, name)!;
      return { acquired: true, epoch: row.epoch, holder: row.holder, expiresAt: row.expiresAt };
    }
    const holder = this.options.worker ? `${ctx.hostId}:${this.options.worker}` : ctx.hostId;
    const result = acquireLease(ctx.store.db, ctx.clock, {
      name,
      holder,
      ttlMs: options.ttlMs,
      skewMs: this.options.skewMs,
    });
    if (!result.acquired) {
      return result;
    }
    const state: HeldLease = { holder, epoch: result.epoch };
    this.held.set(name, state);
    state.timer = setInterval(() => {
      if (this.ctx !== ctx || this.held.get(name) !== state) {
        return;
      }
      try {
        if (!renewLease(ctx.store.db, ctx.clock, name, holder, state.epoch, options.ttlMs)) {
          this.lost(ctx, name, state);
        }
      } catch (error) {
        this.lost(ctx, name, state);
        this.report(ctx, error);
      }
    }, options.renewEveryMs);
    ctx.bus.publish("lease:acquired", { name, holder, epoch: state.epoch });
    return result;
  }

  epoch(name: string): number | undefined {
    const state = this.held.get(name);
    if (!state) {
      return undefined;
    }
    const ctx = this.context();
    try {
      assertLeaseHeld(ctx.store.db, ctx.clock, name, state.holder, state.epoch);
      return state.epoch;
    } catch (error) {
      this.lost(ctx, name, state);
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
      return undefined;
    }
  }

  async withLease<T>(name: string, fn: (epoch: number) => T | Promise<T>): Promise<T> {
    const ctx = this.context();
    const epoch = this.epoch(name);
    const holder = this.options.worker ? `${ctx.hostId}:${this.options.worker}` : ctx.hostId;
    if (epoch === undefined) {
      throw new LeaseLostError(name, holder, 0);
    }
    const result = await fn(epoch);
    assertLeaseHeld(ctx.store.db, ctx.clock, name, holder, epoch);
    return result;
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    this.ctx = undefined;
    const errors: unknown[] = [];
    for (const [name, state] of this.held) {
      try {
        releaseLease(ctx.store.db, ctx.clock, name, state.holder, state.epoch);
      } catch (error) {
        errors.push(error);
      } finally {
        this.lost(ctx, name, state);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "释放租约失败");
    }
  }

  private context(): HostContext {
    if (!this.ctx) {
      throw new Error("租约维护器尚未启动或已经停止");
    }
    return this.ctx;
  }

  private lost(ctx: HostContext, name: string, state: HeldLease): void {
    clearInterval(state.timer);
    this.held.delete(name);
    ctx.bus.publish("lease:lost", { name, holder: state.holder, epoch: state.epoch });
  }

  private report(ctx: HostContext, error: unknown): void {
    try {
      const result = ctx.config.onError
        ? ctx.config.onError(error, "leases")
        : console.error("租约维护器错误", error);
      Promise.resolve(result).catch(() => {});
    } catch {}
  }
}
