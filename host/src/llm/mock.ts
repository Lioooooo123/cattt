import { setTimeout as delay } from "node:timers/promises";
import type { ModelClient, ModelRequest } from "./types.ts";

export function createMockModel(delayMs = 0, recordRequests = false, role: "chat" | "extract" | "router" | "cat_diary" = "chat"): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider: "mock", modelId: `mock-${role === "cat_diary" ? "extract" : role}`, requests,
    async *stream(request, signal) {
      const signals = [signal, request.signal].filter((s): s is AbortSignal => s !== undefined);
      const combined = signals.length ? AbortSignal.any(signals) : undefined;
      combined?.throwIfAborted();
      request.guard?.();
      if (recordRequests) { requests.push(request); }
      const deltas = role === "cat_diary" ? [mockCatDiary(request)]
        : role === "extract" ? ['{"confirmed":[],"pending":[]}']
        : role === "router" ? ['{"decision":"silent","rule_id":"ask_outcome","version":1}']
        : ["听到了，", "我在这里陪你。喵。"];
      for (const delta of deltas) {
        if (delayMs) { await delay(delayMs, undefined, { signal: combined }); }
        combined?.throwIfAborted();
        yield { type: "text-delta", delta };
      }
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

function mockCatDiary({ messages }: ModelRequest): string {
  const { facts } = JSON.parse(messages.at(-1)!.content) as { facts: { id: string }[] };
  return JSON.stringify({ reflection: "心里软软的。", fact_ids: facts.slice(0, 4).map(({ id }) => id) });
}
