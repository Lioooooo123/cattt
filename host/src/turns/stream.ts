import type { HostContext } from "../runtime/index.ts";
import { getHostMeta } from "../store/host-meta.ts";
import { active } from "../store/turn-writes.ts";
import { readTurnFeed, terminalEvent } from "../store/turns.ts";

export async function* streamTurn(ctx: HostContext, id: string, cursor: string | null, signal: AbortSignal): AsyncGenerator<{ cursor: string; kind: string; data: unknown }, string> {
  const generation = getHostMeta(ctx.store.db, "phone_sync_generation");
  const streamHost = generation ? `${ctx.hostId}.${generation}` : ctx.hostId;
  let last = 0;
  let snapshot = false;
  if (cursor !== null) {
    const prefix = `${streamHost}.`;
    const suffix = cursor.slice(prefix.length);
    if (cursor.startsWith(prefix) && /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) {
      last = Number(suffix);
    } else {
      snapshot = true;
    }
  }
  let wake: (() => void) | undefined;
  let notified = false;
  const remove = ctx.bus.subscribe("chat:event", (event) => {
    if (event.streamId === id) {
      notified = true;
      wake?.();
    }
  });
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort, { once: true });
  let initial = true;
  let snapshotSeq = -1;
  try {
    while (!signal.aborted) {
      notified = false;
      const feed = readTurnFeed(ctx.store.db, ctx.clock, id, last);
      if (snapshot || !feed.replayable || (initial && cursor !== null && !active(feed.row) && last === feed.row.eventSeq)) {
        last = feed.row.eventSeq;
        const checkpoint = `${streamHost}.${last}`;
        if (snapshotSeq !== last) {
          yield { cursor: checkpoint, kind: "snapshot", data: { text: feed.text } };
          snapshotSeq = last;
        }
        if (!active(feed.row)) {
          yield { cursor: checkpoint, ...terminalEvent(feed.row) };
          return "end";
        }
        snapshot = false;
      } else {
        for (const event of feed.events) {
          if (signal.aborted) {
            return "aborted";
          }
          last = event.seq;
          yield { ...event, cursor: `${streamHost}.${last}` };
          if (event.terminal) {
            return "end";
          }
        }
        if (feed.events.length) {
          initial = false;
          continue;
        }
      }
      initial = false;
      if (!notified && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => wake?.(), 1000);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    }
    return "aborted";
  } finally {
    wake?.();
    remove();
    signal.removeEventListener("abort", onAbort);
  }
}
