import { ChatEventSweeper } from "../chat-events/index.ts";
import { Gateway } from "../gateway/index.ts";
import type { GatewayOptions } from "../gateway/index.ts";
import { GroupSends } from "../group-sends/index.ts";
import { JobRunner } from "../jobs/index.ts";
import { registerMemoryActions } from "../member-resources/memory-actions.ts";
import { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import type { GroupReplyPolicy } from "../store/conversations.ts";
import { TurnRunner } from "../turns/index.ts";

export function createHostComponents(
  options: Omit<GatewayOptions, "groupSends" | "peerBehavior"> = {}, groupReply?: GroupReplyPolicy,
) {
  const peerBehavior = new PeerBehaviorChannel(() => gateway.peerTransport);
  registerMemoryActions(peerBehavior);
  const groupSends = new GroupSends(peerBehavior, groupReply);
  const gateway: Gateway = new Gateway({ ...options, groupSends, peerBehavior });
  const jobs = new JobRunner();
  peerBehavior.registerDelivery(jobs);
  return {
    gateway,
    components: [new ChatEventSweeper(), new TurnRunner(), gateway, groupSends, jobs],
  };
}
