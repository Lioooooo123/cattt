import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";

interface UuidState {
  timeMs: number;
  random: bigint;
}

const states = new WeakMap<Clock, UuidState>();
const RANDOM_MASK = (1n << 74n) - 1n;

export function uuidv7(clock: Clock): string {
  const wall = clock.wallMs();
  validateWallMs(wall);
  const previous = states.get(clock);
  let timeMs = Math.max(wall, previous?.timeMs ?? 0);
  let random: bigint;

  if (previous && timeMs === previous.timeMs) {
    random = previous.random + 1n;
    if (random > RANDOM_MASK) {
      timeMs += 1;
      random = 0n;
    }
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    random = BigInt(`0x${Buffer.from(bytes).toString("hex")}`) & RANDOM_MASK;
  }

  validateWallMs(timeMs);
  states.set(clock, { timeMs, random });
  const timestamp = BigInt(timeMs) << 80n;
  const randA = (random >> 62n) << 64n;
  const randB = random & ((1n << 62n) - 1n);
  const hex = (timestamp | (7n << 76n) | randA | (2n << 62n) | randB)
    .toString(16).padStart(32, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
