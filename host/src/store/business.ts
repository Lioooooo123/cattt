import { encodeHlc } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";

export function revision(clock: Clock) {
  const updatedAt = clock.wallMs();
  validateWallMs(updatedAt);
  return { hlc: encodeHlc(clock.hlc()), updatedAt };
}

export function businessRow(clock: Clock, originHostId: string) {
  const id = uuidv7(clock);
  const update = revision(clock);
  return { id, originHostId, ...update, rev: 1, createdAt: update.updatedAt, deletedAt: null };
}
