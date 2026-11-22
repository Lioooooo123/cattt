import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Actor } from "../identity/index.ts";
import { getHouseholdMember, isActiveDeviceActor } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { memberResourceReceipts } from "./schema/member-resources.ts";

export type MemberResourceDb = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];

const statusByCode = {
  unauthorized: 401,
  invalid_request: 400,
  not_found: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  source_unavailable: 409,
  wrong_home_host: 409,
  peer_write_unavailable: 409,
} as const;

export class MemberResourceError extends Error {
  readonly status;

  constructor(readonly code: keyof typeof statusByCode, readonly writerHostId?: string) {
    super(code);
    this.status = statusByCode[code];
  }
}

export function requireMemberResourceActor(db: Pick<StoreDb, "select">, actor: Actor) {
  if (!isActiveDeviceActor(db, actor)) {
    throw new MemberResourceError("unauthorized");
  }
  const member = getHouseholdMember(db, actor.householdId, actor.memberId)!;
  if (member.homeHostId !== actor.hostId) {
    throw new MemberResourceError("wrong_home_host", member.homeHostId);
  }
}

export function getMemberResourceReceipt(db: Pick<StoreDb, "select">, memberId: string, requestId: string) {
  const table = memberResourceReceipts;
  return db.select().from(table).where(and(eq(table.memberId, memberId), eq(table.requestId, requestId))).get();
}

/** 同一事务写入业务修订和收据。重放时仅取资源 ID，随后按当前权限重新投影。 */
export function commitMemberResource<T>(
  db: StoreDb, actor: Actor, requestId: string, operation: string, input: unknown,
  change: (db: MemberResourceDb) => string,
  project: (db: MemberResourceDb, id: string) => T,
) {
  const requestHash = createHash("sha256").update(JSON.stringify([operation, input])).digest("hex");
  return db.transaction((tx) => {
    requireMemberResourceActor(tx, actor);
    const existing = getMemberResourceReceipt(tx, actor.memberId, requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new MemberResourceError("idempotency_conflict");
      }
      return { value: project(tx, existing.resourceId), replayed: true };
    }
    const id = change(tx);
    tx.insert(memberResourceReceipts).values({ memberId: actor.memberId, requestId, requestHash, resourceId: id }).run();
    return { value: project(tx, id), replayed: false };
  }, { behavior: "immediate" });
}
