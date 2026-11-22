import { and, asc, eq } from "drizzle-orm";
import type { Actor } from "../identity/index.ts";
import { textSha256 } from "../import-pg/values.ts";
import type { StoreDb } from "./index.ts";
import { importedCatDiary, importedMemoryBlocks, importedMemoryRestrictions } from "./schema/pg-import.ts";

type Reader = Pick<StoreDb, "select">;

export function listImportedCatDiary(db: Reader, actor: Actor) {
  return db.select().from(importedCatDiary)
    .where(eq(importedCatDiary.householdId, actor.householdId))
    .orderBy(asc(importedCatDiary.localDay), asc(importedCatDiary.recordedAt), asc(importedCatDiary.id)).all()
    .map(({ id, ownerMemberId, rev, text, recordedAt, localDay, timeZone, updatedAt }) => ({
      id, owner_member_id: ownerMemberId, revision: rev, text, recorded_at: recordedAt,
      local_day: localDay, time_zone: timeZone, updated_at: updatedAt,
    }));
}

export function importedMemoryPreferences(db: Reader, memberId: string) {
  return db.select().from(importedMemoryRestrictions).where(eq(importedMemoryRestrictions.memberId, memberId)).get();
}

export function matchesImportedMemoryBlock(db: Reader, subjectMemberId: string | null, predicate: string) {
  if (subjectMemberId === null) return false;
  const key = predicate.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const fingerprint = textSha256(`用户|${key}`).slice(0, 32);
  return !!db.select({ fingerprint: importedMemoryBlocks.fingerprint }).from(importedMemoryBlocks)
    .where(and(eq(importedMemoryBlocks.memberId, subjectMemberId), eq(importedMemoryBlocks.fingerprint, fingerprint))).get();
}
