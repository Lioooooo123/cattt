import type { Replier } from "./types.ts";

export class DevelopmentEchoReplier implements Replier {
  async *reply({ trigger, signal }: Parameters<Replier["reply"]>[0]) {
    signal.throwIfAborted();
    yield `（开发回复，未接入模型）收到：${trigger.text}`;
  }
}
