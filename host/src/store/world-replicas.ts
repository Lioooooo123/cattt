import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { businessFields, businessId } from "../replication/types.ts";
import type { ReplicationSource } from "../replication/types.ts";
import { actionStatuses, destinationIds, profileSchema, snapshotSchema } from "../world/protocol.ts";
import type { ActionStatus, Profile, WorldSnapshot } from "../world/protocol.ts";
import { publicationIsSealed, publicationProof } from "./publication.ts";
import { hostInHousehold, household, memberInHousehold } from "./replica-scope.ts";
import { assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter, requireReplicaDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { worldActions, worldCats, worldStates } from "./schema/world.ts";

const shared = {
  ...businessFields,
  deletedAt: z.null(),
  householdId: businessId,
  epoch: z.int().positive(),
  grantId: z.uuid(),
};
const forCat = { ...shared, catId: businessId };
const instant = z.int().nonnegative();

type PublicationRow = { householdId: string; originHostId: string; epoch: number; grantId: string };
function authorize(tx: ReplicationTx, source: ReplicationSource, row: PublicationRow) {
  assertReplicaWriter(row.householdId === source.householdId && row.originHostId === source.sourceHostId);
  household(tx, row.householdId);
  hostInHousehold(tx, row.originHostId, row.householdId);
  const proof = requireReplicaDependency(publicationProof(tx, row.householdId, row.epoch), "publication_epoch", row.householdId);
  assertReplicaWriter(proof.holderHostId === row.originHostId && proof.grantId === row.grantId);
}

export function authorizeCat(tx: ReplicationTx, source: ReplicationSource, row: PublicationRow & { catId: string }) {
  authorize(tx, source, row);
  const cat = requireReplicaDependency(tx.select().from(worldCats).where(eq(worldCats.id, row.catId)).get(), "world_cat", row.catId);
  assertReplicaWriter(cat.householdId === row.householdId && cat.epoch <= row.epoch);
}

function sealed(tx: ReplicationTx, row: PublicationRow) {
  return publicationIsSealed(tx, row.householdId, row.epoch);
}

export const worldReplicas = {
  world_cat: defineReplicationAdapter("world_cat", z.strictObject({ ...shared, legacyId: z.uuid().nullable() }), {
    read: (tx, id) => tx.select().from(worldCats).where(eq(worldCats.id, id)).get() as CatRow | undefined,
    snapshotRows: (tx, source, limit) => tx.select().from(worldCats).where(and(
      eq(worldCats.originHostId, source.sourceHostId), eq(worldCats.householdId, source.householdId),
    )).orderBy(asc(worldCats.id)).limit(limit).all() as CatRow[],
    write: (tx, row) => { tx.insert(worldCats).values(row).onConflictDoUpdate({ target: worldCats.id, set: row }).run(); },
    authorize(tx, source, row) {
      authorize(tx, source, row);
      assertReplicaIdentity(row.rev === 1);
      const existing = tx.select().from(worldCats).where(eq(worldCats.householdId, row.householdId)).get();
      assertReplicaIdentity(!existing || existing.id === row.id);
    },
    identity: (row) => [row.householdId, row.legacyId, row.epoch, row.grantId],
    sealed,
  }),
  world_state: defineReplicationAdapter("world_state", z.strictObject({
    ...forCat, profile: profileSchema, snapshot: snapshotSchema.nullable(), observedAt: instant.nullable(),
  }), {
    read: (tx, id) => tx.select().from(worldStates).where(eq(worldStates.id, id)).get() as WorldRow | undefined,
    snapshotRows: (tx, source, limit) => tx.select().from(worldStates).where(and(
      eq(worldStates.originHostId, source.sourceHostId), eq(worldStates.householdId, source.householdId),
    )).orderBy(asc(worldStates.id)).limit(limit).all() as WorldRow[],
    write: (tx, row) => { tx.insert(worldStates).values(row).onConflictDoUpdate({ target: worldStates.id, set: row }).run(); },
    authorize(tx, source, row) {
      authorizeCat(tx, source, row);
      assertReplicaIdentity((row.snapshot === null) === (row.observedAt === null));
      const existing = tx.select().from(worldStates).where(and(
        eq(worldStates.householdId, row.householdId), eq(worldStates.epoch, row.epoch),
      )).get();
      assertReplicaIdentity(!existing || existing.id === row.id);
    },
    identity: (row) => [row.householdId, row.catId, row.epoch, row.grantId],
    sealed,
  }),
  world_action: defineReplicationAdapter("world_action", z.strictObject({
    ...forCat,
    memberId: businessId, requestId: z.uuid(), destinationId: z.enum(destinationIds), activity: z.literal("sit").nullable(),
    stateVersion: z.int().nonnegative(), status: z.enum(actionStatuses), reason: z.string().max(80).nullable(),
    acceptBefore: instant, finishBefore: instant, resultSnapshot: snapshotSchema.nullable(), occurredAt: instant.nullable(),
  }), {
    read: (tx, id) => tx.select().from(worldActions).where(eq(worldActions.id, id)).get() as ActionRow | undefined,
    snapshotRows: (tx, source, limit) => tx.select().from(worldActions).where(and(
      eq(worldActions.originHostId, source.sourceHostId), eq(worldActions.householdId, source.householdId),
    )).orderBy(asc(worldActions.id)).limit(limit).all() as ActionRow[],
    write: (tx, row) => { tx.insert(worldActions).values(row).onConflictDoUpdate({ target: worldActions.id, set: row }).run(); },
    authorize(tx, source, row) {
      authorizeCat(tx, source, row);
      memberInHousehold(tx, row.memberId, row.householdId);
      const existing = tx.select().from(worldActions).where(and(
        eq(worldActions.householdId, row.householdId), eq(worldActions.memberId, row.memberId), eq(worldActions.requestId, row.requestId),
      )).get();
      assertReplicaIdentity(!existing || existing.id === row.id);
    },
    identity: (row) => [row.householdId, row.catId, row.epoch, row.grantId, row.memberId, row.requestId,
      row.destinationId, row.activity, row.stateVersion, row.acceptBefore, row.finishBefore],
    sealed,
  }),
};

type CatRow = Omit<typeof worldCats.$inferSelect, "deletedAt"> & { deletedAt: null };
export type WorldRow = Omit<typeof worldStates.$inferSelect, "deletedAt" | "profile" | "snapshot"> & {
  deletedAt: null; profile: Profile; snapshot: WorldSnapshot | null;
};
export type ActionRow = Omit<typeof worldActions.$inferSelect, "deletedAt" | "resultSnapshot" | "status" | "activity" | "destinationId"> & {
  deletedAt: null; resultSnapshot: WorldSnapshot | null; status: ActionStatus; activity: "sit" | null;
  destinationId: typeof destinationIds[number];
};

export function worldPublicationHistory(tx: ReplicationTx, householdId: string, epoch: number) {
  const scope = { householdId, epoch };
  // Each table is read in a stable order. Both sides must have this epoch's
  // final business state before they commit a transfer.
  return [
    ...tx.select().from(worldCats).where(and(eq(worldCats.householdId, scope.householdId), eq(worldCats.epoch, scope.epoch)))
      .orderBy(asc(worldCats.id)).all().map((row) => ["world_cat", row]),
    ...tx.select().from(worldStates).where(and(eq(worldStates.householdId, scope.householdId), eq(worldStates.epoch, scope.epoch)))
      .orderBy(asc(worldStates.id)).all().map((row) => ["world_state", row]),
    ...tx.select().from(worldActions).where(and(eq(worldActions.householdId, scope.householdId), eq(worldActions.epoch, scope.epoch)))
      .orderBy(asc(worldActions.id)).all().map((row) => ["world_action", row]),
  ];
}
