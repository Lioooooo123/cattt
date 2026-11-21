import { MAX_LOGICAL, validateHlc, validateWallMs } from "./hlc.ts";
import type { Hlc } from "./hlc.ts";

export type { Hlc } from "./hlc.ts";
export { compareHlc, encodeHlc, parseHlc } from "./hlc.ts";

export interface Clock {
  wallMs(): number;
  hlc(): Hlc;
  observe(remote: Hlc): Hlc;
}

export function clockDate(clock: Clock, offsetMs = 0): Date {
  const now = clock.wallMs();
  validateWallMs(now);
  return new Date(now + offsetMs);
}

export interface ClockOptions {
  maxDriftMs?: number;
}

export class ClockDriftError extends Error {
  constructor(
    public readonly remoteMs: number,
    public readonly wallMs: number,
    public readonly maxDriftMs: number,
  ) {
    super("远端时间超出允许的时钟偏差");
    this.name = "ClockDriftError";
  }
}

abstract class HybridClock implements Clock {
  private last: Hlc | undefined;
  private readonly maxDriftMs: number;

  constructor(private readonly nodeId: string, options: ClockOptions = {}) {
    validateHlc({ physicalMs: 0, logical: 0, nodeId });
    this.maxDriftMs = options.maxDriftMs ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(this.maxDriftMs) || this.maxDriftMs < 0) {
      throw new RangeError("最大时钟偏差须为非负整数");
    }
  }

  abstract wallMs(): number;

  hlc(): Hlc {
    return this.next();
  }

  observe(remote: Hlc): Hlc {
    validateHlc(remote);
    return this.next(remote);
  }

  private next(remote?: Hlc): Hlc {
    const wall = this.wallMs();
    validateWallMs(wall);
    if (remote && remote.physicalMs - wall > this.maxDriftMs) {
      throw new ClockDriftError(remote.physicalMs, wall, this.maxDriftMs);
    }
    let physicalMs = Math.max(wall, this.last?.physicalMs ?? 0, remote?.physicalMs ?? 0);
    let logical = 0;
    if (this.last?.physicalMs === physicalMs && remote?.physicalMs === physicalMs) {
      logical = Math.max(this.last.logical, remote.logical) + 1;
    } else if (this.last?.physicalMs === physicalMs) {
      logical = this.last.logical + 1;
    } else if (remote?.physicalMs === physicalMs) {
      logical = remote.logical + 1;
    }
    if (logical > MAX_LOGICAL) {
      physicalMs += 1;
      logical = 0;
    }
    const next = { physicalMs, logical, nodeId: this.nodeId };
    validateHlc(next);
    this.last = next;
    return { ...next };
  }
}

export class SystemClock extends HybridClock {
  wallMs(): number {
    return Date.now();
  }
}

export class ManualClock extends HybridClock {
  constructor(nodeId: string, private timeMs = 0, options: ClockOptions = {}) {
    super(nodeId, options);
    validateWallMs(timeMs);
  }

  wallMs(): number {
    return this.timeMs;
  }

  setWallMs(timeMs: number): void {
    validateWallMs(timeMs);
    this.timeMs = timeMs;
  }

  advance(ms: number): void {
    this.setWallMs(this.timeMs + ms);
  }
}
