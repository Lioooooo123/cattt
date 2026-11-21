import type { HostContext } from "../src/runtime/index.ts";
import { createDevice, createMember } from "../src/store/identity.ts";

export function issueTestDevice(host: HostContext, displayName = "成员") {
  const memberId = createMember(host.store.db, host.clock, {
    householdId: host.householdId,
    homeHostId: host.hostId,
    displayName,
    maxMembers: host.config.maxMembers,
  });
  return {
    memberId,
    ...createDevice(host.store.db, host.clock, { memberId, hostId: host.hostId, name: "iPhone" }),
  };
}
