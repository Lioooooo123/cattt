import type { Actor } from "./index.ts";
import type { getMember } from "../store/identity.ts";

type Member = NonNullable<ReturnType<typeof getMember>>;

export function actorDto(actor: Actor) {
  return { member_id: actor.memberId, device_id: actor.deviceId, host_id: actor.hostId, household_id: actor.householdId };
}

export function memberProfile(member: Pick<Member, "id" | "householdId" | "displayName" | "homeHostId">) {
  return { id: member.id, household_id: member.householdId, display_name: member.displayName, home_host_id: member.homeHostId };
}

export function memberRecord(member: Member) {
  return {
    ...memberProfile(member), origin_host_id: member.originHostId, hlc: member.hlc, rev: member.rev,
    created_at: member.createdAt, updated_at: member.updatedAt, deleted_at: member.deletedAt,
  };
}
