import { setTimeout as delay } from "node:timers/promises";
import type { ModelClient, ModelRequest } from "./types.ts";

export function createMockModel(delayMs = 0, recordRequests = false): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider: "mock", modelId: "mock-chat", requests,
    async *stream(request, signal) {
      const signals = [signal, request.signal].filter((s): s is AbortSignal => s !== undefined);
      const combined = signals.length ? AbortSignal.any(signals) : undefined;
      combined?.throwIfAborted();
      if (recordRequests) { requests.push(request); }
      for (const delta of ["听到了，", "我在这里陪你。喵。"]) {
        if (delayMs) { await delay(delayMs, undefined, { signal: combined }); }
        combined?.throwIfAborted();
        yield { type: "text-delta", delta };
      }
      yield { type: "finish", finishReason: "stop" };
    },
  };
}
