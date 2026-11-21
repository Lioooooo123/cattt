import type { Actor } from "./index.ts";

export interface Resource {
  householdId: string;
  memberId?: string;
}

export class AccessDeniedError extends Error {
  constructor() {
    super("无权访问此资源");
    this.name = "AccessDeniedError";
  }
}

export function can(actor: Actor, resource: Resource): boolean {
  return actor.householdId === resource.householdId;
}

export function canWriteAs(actor: Actor, memberId: string): boolean {
  return actor.memberId === memberId;
}

export function assertCan(actor: Actor, resource: Resource): void {
  if (!can(actor, resource)) {
    throw new AccessDeniedError();
  }
}
