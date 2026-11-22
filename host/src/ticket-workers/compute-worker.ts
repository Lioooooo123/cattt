import { compute } from "./compute.ts";
import type { ComputeRequest } from "./compute.ts";
import type { ComputeReply } from "../ticket-worker-isolation.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<ComputeRequest>) => {
  let reply: ComputeReply;
  try {
    reply = { ok: true, result: compute(event.data) };
  } catch {
    reply = { ok: false };
  }
  self.postMessage(reply);
};
