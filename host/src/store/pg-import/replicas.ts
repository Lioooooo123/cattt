import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { businessFields, businessId } from "../../replication/types.ts";
import type { ReplicationSource } from "../../replication/types.ts";
import { matchesDiaryLocalDay } from "../diary-date.ts";
import { assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter } from "../replication-adapter.ts";
import type { ReplicationTx } from "../replication-adapter.ts";
import { household, hostInHousehold, memberInHousehold } from "../replica-scope.ts";
import { importedCatDiary, importedMemoryBlocks, importedMemoryRestrictions } from "../schema/pg-import.ts";

function authorizeLegacy(
  tx: ReplicationTx, source: ReplicationSource,
  row: { id: string; originHostId: string; householdId: string; deletedAt: number | null },
  memberId: string,
) {
  assertReplicaWriter(row.householdId === source.householdId && row.originHostId === source.sourceHostId
    && row.deletedAt === null);
  const family = household(tx, row.householdId);
  hostInHousehold(tx, source.sourceHostId, row.householdId);
  const member = memberInHousehold(tx, memberId, row.householdId);
  // The first host authenticated the old singleton account during import.
  // These read-only historical facts retain that provenance after peer join.
  assertReplicaWriter(family.originHostId === source.sourceHostId && member.originHostId === source.sourceHostId);
}

export const pgImportReplicas = {
  legacy_cat_diary: defineReplicationAdapter("legacy_cat_diary", z.strictObject({
    ...businessFields, householdId: businessId, ownerMemberId: businessId, text: z.string().min(1),
    recordedAt: z.int().nonnegative(), localDay: z.iso.date(), timeZone: z.string().min(1),
  }), {
    read: (tx, id) => tx.select().from(importedCatDiary).where(eq(importedCatDiary.id, id)).get(),
    snapshotRows: (tx, source, limit) => tx.select().from(importedCatDiary).where(and(
      eq(importedCatDiary.householdId, source.householdId), eq(importedCatDiary.originHostId, source.sourceHostId),
    )).orderBy(asc(importedCatDiary.id)).limit(limit).all(),
    write: (tx, row) => { tx.insert(importedCatDiary).values(row).run(); },
    authorize(tx, source, row) {
      authorizeLegacy(tx, source, row, row.ownerMemberId);
      assertReplicaWriter(matchesDiaryLocalDay(row));
    },
    identity: (row) => [row.householdId, row.ownerMemberId],
    fact: (row) => [row],
  }),
  legacy_memory_restrictions: defineReplicationAdapter("legacy_memory_restrictions", z.strictObject({
    ...businessFields, householdId: businessId, memberId: businessId,
    learningDisabled: z.boolean(), recallDisabled: z.boolean(),
  }), {
    read: (tx, id) => tx.select().from(importedMemoryRestrictions).where(eq(importedMemoryRestrictions.id, id)).get(),
    snapshotRows: (tx, source, limit) => tx.select().from(importedMemoryRestrictions).where(and(
      eq(importedMemoryRestrictions.householdId, source.householdId), eq(importedMemoryRestrictions.originHostId, source.sourceHostId),
    )).orderBy(asc(importedMemoryRestrictions.id)).limit(limit).all(),
    write: (tx, row) => { tx.insert(importedMemoryRestrictions).values(row).run(); },
    authorize(tx, source, row) {
      authorizeLegacy(tx, source, row, row.memberId);
      assertReplicaWriter(row.rev === 1 && (row.learningDisabled || row.recallDisabled));
      const previous = tx.select().from(importedMemoryRestrictions).where(eq(importedMemoryRestrictions.memberId, row.memberId)).get();
      assertReplicaIdentity(!previous || previous.id === row.id);
    },
    identity: (row) => [row.householdId, row.memberId],
    fact: (row) => [row],
  }),
  legacy_memory_block: defineReplicationAdapter("legacy_memory_block", z.strictObject({
    ...businessFields, householdId: businessId, memberId: businessId, fingerprint: z.string().min(1),
  }), {
    read: (tx, id) => tx.select().from(importedMemoryBlocks).where(eq(importedMemoryBlocks.id, id)).get(),
    snapshotRows: (tx, source, limit) => tx.select().from(importedMemoryBlocks).where(and(
      eq(importedMemoryBlocks.householdId, source.householdId), eq(importedMemoryBlocks.originHostId, source.sourceHostId),
    )).orderBy(asc(importedMemoryBlocks.id)).limit(limit).all(),
    write: (tx, row) => { tx.insert(importedMemoryBlocks).values(row).run(); },
    authorize(tx, source, row) {
      authorizeLegacy(tx, source, row, row.memberId);
      assertReplicaWriter(row.rev === 1);
      const previous = tx.select().from(importedMemoryBlocks).where(and(
        eq(importedMemoryBlocks.memberId, row.memberId), eq(importedMemoryBlocks.fingerprint, row.fingerprint),
      )).get();
      assertReplicaIdentity(!previous || previous.id === row.id);
    },
    identity: (row) => [row.householdId, row.memberId, row.fingerprint],
    fact: (row) => [row],
  }),
};
