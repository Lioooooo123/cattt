import { and, asc, eq, gt, isNotNull, lte, ne } from "drizzle-orm";
import type { StoreDb } from "./index.ts";
import { memberChangeProjections as changes } from "./schema/member-changes.ts";

interface Scope {
  householdId: string;
  memberId: string;
  generation: string;
}

export interface MemberProjectionKey {
  kind: string;
  resourceId: string;
}

interface Digest extends MemberProjectionKey {
  fingerprint: string;
}

export function memberProjectionKey({ kind, resourceId }: MemberProjectionKey): string {
  return JSON.stringify([kind, resourceId]);
}

function memberScope(scope: Scope) {
  return and(eq(changes.householdId, scope.householdId), eq(changes.memberId, scope.memberId));
}

/** 调用方在同一个写事务内读取全部可见 DTO、维护索引并取页。 */
export function reconcileMemberChangeIndex(db: StoreDb, scope: Scope, current: ReadonlyMap<string, Digest>) {
  const { householdId, memberId, generation } = scope;
  const member = memberScope(scope);
  db.delete(changes).where(and(member, ne(changes.generation, generation))).run();
  const rows = db.select().from(changes).where(member).orderBy(asc(changes.sequence)).all();
  const previous = new Map(rows.map((row) => [memberProjectionKey(row), row]));
  const previousHead = rows.at(-1)?.sequence ?? 0;
  let head = previousHead;

  const save = (key: MemberProjectionKey, fingerprint: string | null) => {
    head += 1;
    db.insert(changes).values({
      householdId, memberId, generation, kind: key.kind, resourceId: key.resourceId, fingerprint, sequence: head,
    }).onConflictDoUpdate({
      target: [changes.householdId, changes.memberId, changes.kind, changes.resourceId],
      set: { fingerprint, sequence: head },
    }).run();
  };
  for (const [key, row] of current) {
    if (previous.get(key)?.fingerprint !== row.fingerprint) {
      save(row, row.fingerprint);
    }
  }
  for (const [key, row] of previous) {
    if (row.fingerprint !== null && !current.has(key)) {
      save(row, null);
    }
  }
  return { head, previousHead };
}

export function readMemberChangeIndex(
  db: Pick<StoreDb, "select">, scope: Scope,
  range: { after: number; through: number; opening: boolean; limit: number },
) {
  return db.select().from(changes).where(and(
    memberScope(scope), eq(changes.generation, scope.generation),
    gt(changes.sequence, range.after), lte(changes.sequence, range.through),
    range.opening ? isNotNull(changes.fingerprint) : undefined,
  )).orderBy(asc(changes.sequence)).limit(range.limit).all();
}
