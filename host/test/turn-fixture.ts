import { ChatEvents } from "../src/chat-events/index.ts";
import type { HostContext } from "../src/runtime/index.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { acquireLease } from "../src/store/leases.ts";
import { appendDelta, claimTurn, finishTurn } from "../src/store/turns.ts";

export function testTurn(host: HostContext, token: string) {
  const actor = resolveDeviceToken(host.store.db, host.clock, token)!;
  const direct = listConversations(host.store.db, actor).find((row) => row.kind === "direct")!;
  const events = new ChatEvents(host);
  const result = events.write((db, append) => sendMessage(db, host.clock, actor, direct.id, { clientMessageId: crypto.randomUUID(), text: "你好" }, append));
  const turn = result.body.turn!;
  const fence = { name: `conversation:${direct.id}`, holder: `test:${turn.id}`, epoch: 0 };
  const lease = acquireLease(host.store.db, host.clock, { ...fence, ttlMs: 3600_000 });
  if (!lease.acquired) {
    throw new Error("测试租约被占用");
  }
  fence.epoch = lease.epoch;
  claimTurn(host.store.db, host.clock, turn.id, fence);
  return {
    turn, actor, fence,
    delta: (text: string) => events.write((db, append) => appendDelta(db, host.clock, turn.id, text, fence, append)),
    done: () => events.write((db, append) => finishTurn(db, host.clock, turn.id, { status: "completed", fence }, append)),
  };
}
