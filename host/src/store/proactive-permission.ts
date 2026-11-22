import { eq } from "drizzle-orm";
import type { Actor } from "../identity/index.ts";
import { DEFAULT_TICKET_TIME_ZONE } from "../tickets/time.ts";
import { getHouseholdMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { proactivePermissions } from "./schema/inference.ts";

export function readProactivePermission(db: Pick<StoreDb, "select">, memberId: string) {
  return db.select().from(proactivePermissions).where(eq(proactivePermissions.memberId, memberId)).get()
    ?? { memberId, allowed: false, revision: 0, timeZone: DEFAULT_TICKET_TIME_ZONE };
}

export class ProactiveNotHomeError extends Error {}

export function setProactivePermission(
  db: Pick<StoreDb, "transaction">, actor: Actor, allowed: boolean, timeZone?: string,
) {
  return db.transaction((tx) => {
    const member = getHouseholdMember(tx, actor.householdId, actor.memberId);
    if (!member || member.homeHostId !== actor.hostId) { throw new ProactiveNotHomeError(); }
    const current = readProactivePermission(tx, actor.memberId);
    const zone = timeZone ?? current.timeZone;
    if (current.allowed === allowed && current.timeZone === zone) { return current; }
    const next = { memberId: actor.memberId, allowed, timeZone: zone, revision: current.revision + 1 };
    tx.insert(proactivePermissions).values(next)
      .onConflictDoUpdate({ target: proactivePermissions.memberId, set: next }).run();
    return next;
  }, { behavior: "immediate" });
}
