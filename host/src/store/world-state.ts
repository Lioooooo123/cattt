import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { mappedId, textSha256 } from "../import-pg/values.ts";
import { compileBehavior } from "../world/behavior.ts";
import { projectSnapshot } from "../world/wire.ts";
import type { Clock } from "../clock/index.ts";
import { wallDate } from "../clock/index.ts";
import type { PublicationProof } from "../publication/types.ts";
import { defaultProfile, profileSchema, snapshotSchema, WorldError } from "../world/protocol.ts";
import type { Profile, WorldSnapshot } from "../world/protocol.ts";
import { businessRow, revision } from "./business.ts";
import type { StoreDb } from "./index.ts";
import { appendNativeChange, atomicNativeChanges } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { getHousehold } from "./identity.ts";
import { readPublicationRoute, requireSharedPublisher } from "./publication.ts";
import type { HostContext } from "../runtime/index.ts";
import { pgImportArchive, pgImportReceipts } from "./schema/pg-import.ts";
import { worldCats, worldStates } from "./schema/world.ts";
import { worldReplicas } from "./world-replicas.ts";
import type { WorldRow } from "./world-replicas.ts";

type Reader = Pick<StoreDb, "select">;

export function readWorld(db: Reader, householdId: string) {
  const cat = db.select().from(worldCats).where(eq(worldCats.householdId, householdId)).get();
  const state = db.select().from(worldStates).where(eq(worldStates.householdId, householdId))
    .orderBy(desc(worldStates.epoch)).limit(1).get() as WorldRow | undefined;
  return cat && state ? { cat, state } : undefined;
}
type World = NonNullable<ReturnType<typeof readWorld>>;

export function worldRevision(state: WorldRow) {
  return `${state.id}:${state.rev}`;
}

export function projectWorld(db: Reader, householdId: string) {
  const world = readWorld(db, householdId);
  if (!world) return null;
  const { cat, state } = world;
  return {
    id: cat.id, revision: worldRevision(state), updated_at: state.updatedAt, observed_at: state.observedAt,
    adopted_at: cat.createdAt, profile: { ...state.profile, legacy_id: cat.legacyId },
    snapshot: projectSnapshot(state.snapshot),
  };
}

export function behaviorForWorld(world: ReturnType<typeof projectWorld>, now: number) {
  if (!world) return null;
  const localDay = (time: number) => {
    const date = wallDate(time);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const days = Math.max(0, (localDay(now) - localDay(world.adopted_at)) / 86_400_000);
  return compileBehavior(world.profile.temperament, world.profile.traits, days);
}

export function saveWorldState(
  tx: ReplicationTx, clock: Clock, proof: PublicationProof, world: World,
  { profile, snapshot, observedAt }: Pick<WorldRow, "profile" | "snapshot" | "observedAt">,
) {
  const { state, cat } = world;
  if (isDeepStrictEqual(profile, state.profile) && isDeepStrictEqual(snapshot, state.snapshot)) return state;
  const facts = { profile, snapshot, observedAt };
  const row: WorldRow = state.epoch === proof.epoch
    ? { ...state, ...facts, ...revision(clock), rev: state.rev + 1 }
    : { ...businessRow(clock, proof.holderHostId), ...facts, householdId: cat.householdId, catId: cat.id,
        epoch: proof.epoch, grantId: proof.grantId };
  tx.insert(worldStates).values(row).onConflictDoUpdate({ target: worldStates.id, set: row }).run();
  appendNativeChange(tx, proof.holderHostId, proof.householdId, worldReplicas.world_state, row);
  return row;
}

type LegacyFields = {
  id: string; profile: Profile; adoptedAt: number;
  snapshot: WorldSnapshot | null; observedAt: number | null;
};

/** Decode only a proved cat row and its matching old 3D observation. */
export function mapLegacyWorld(cat: Record<string, unknown>, observation?: Record<string, unknown>): LegacyFields | undefined {
  const parts = typeof cat.traits === "object" && cat.traits ? cat.traits : {};
  const profile = profileSchema.safeParse({
    name: cat.name, appearance: cat.appearance, temperament: cat.temperament,
    traits: { ...defaultProfile.traits, ...parts },
  });
  const adoptedAt = typeof cat.created_at === "string" ? Date.parse(cat.created_at) : NaN;
  if (typeof cat.id !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(cat.id)
    || !profile.success || !Number.isSafeInteger(adoptedAt) || adoptedAt < 0) return;
  const parsed = snapshotSchema.safeParse(observation?.snapshot);
  const at = typeof observation?.observed_at === "string" ? Date.parse(observation.observed_at) : NaN;
  const snapshot = observation?.cat_id === cat.id && parsed.success && Number.isSafeInteger(at) && at >= 0
    ? historicalSnapshot(parsed.data) : null;
  return { id: cat.id, profile: profile.data, adoptedAt, snapshot, observedAt: snapshot ? at : null };
}

function historicalSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  const { activity: _activity, activityFallback: _fallback, ...facts } = snapshot;
  return {
    ...facts, stateVersion: 0, targetDestinationId: snapshot.currentDestinationId,
    phase: "idle", action: "idle", paused: false, runnable: false,
  };
}

export function seedWorld(
  tx: ReplicationTx, proof: PublicationProof,
  catBusiness: ReturnType<typeof businessRow>, stateBusiness: ReturnType<typeof businessRow>,
  profile: Profile, imported?: LegacyFields,
) {
  const { holderHostId, householdId, epoch, grantId } = proof;
  const cat = { ...catBusiness, householdId, epoch, grantId, legacyId: imported?.id ?? null };
  const state: WorldRow = {
    ...stateBusiness, householdId, catId: cat.id, epoch, grantId, profile,
    snapshot: imported?.snapshot ?? null, observedAt: imported?.observedAt ?? null,
  };
  const persistedCat = tx.insert(worldCats).values(cat).returning().get();
  const persistedState = tx.insert(worldStates).values(state).returning().get();
  return {
    cat, state, persistedCat, persistedState,
    publish() {
      atomicNativeChanges(tx, holderHostId, () => {
        appendNativeChange(tx, holderHostId, householdId, worldReplicas.world_cat, cat);
        appendNativeChange(tx, holderHostId, householdId, worldReplicas.world_state, state);
      });
    },
  };
}

export function ensureWorld(tx: ReplicationTx, clock: Clock, proof: PublicationProof): World {
  const current = readWorld(tx, proof.householdId);
  if (current) return current;
  // A former R9.1 replica can have a historical grant and still lack the
  // origin's local import archive. Only the family's origin can adopt.
  if (getHousehold(tx, proof.householdId)?.originHostId !== proof.holderHostId) {
    throw new WorldError("world_history_pending");
  }
  const old = readArchivedWorld(tx, proof.householdId, proof.holderHostId);
  if (old === undefined) throw new WorldError("legacy_world_unmapped");
  const cat = businessRow(clock, proof.holderHostId);
  const state = businessRow(clock, proof.holderHostId);
  if (old) {
    cat.id = mappedId(old.userId, "world-cat", old.id, old.adoptedAt);
    cat.createdAt = old.adoptedAt;
    state.id = mappedId(old.userId, "world", old.id, old.adoptedAt);
    state.createdAt = old.adoptedAt;
  }
  const seeded = seedWorld(tx, proof, cat, state, old?.profile ?? defaultProfile, old ?? undefined);
  seeded.publish();
  return { cat: seeded.cat, state: seeded.state };
}

export function restoreArchivedWorld(ctx: HostContext) {
  ctx.store.db.transaction((tx) => {
    const { householdId, hostId, clock, publication } = ctx;
    if (readWorld(tx, householdId) || !readArchivedWorld(tx, householdId, hostId)) return;
    const route = readPublicationRoute(tx, householdId, publication);
    if (route.status === "ready") ensureWorld(tx, clock, requireSharedPublisher(tx, householdId, publication, route.current));
  }, { behavior: "immediate" });
}

function decodeArchive(row: typeof pgImportArchive.$inferSelect) {
  if (textSha256(row.evidenceJson) !== row.sourceSha256) return;
  try {
    return JSON.parse(row.evidenceJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** null means a fresh family, undefined means a claimed but unproved legacy cat. */
function readArchivedWorld(tx: Reader, householdId: string, hostId: string) {
  const receipt = tx.select().from(pgImportReceipts).where(eq(pgImportReceipts.id, 1)).get();
  if (!receipt) return null;
  const report = receipt.report as Partial<{
    status: string; sourceSha256: string; sourceCatId: string | null; sourceUserId: string; householdId: string; hostId: string;
  }>;
  if (report?.status !== "imported" || report.householdId !== householdId || report.hostId !== hostId
    || report.sourceSha256 !== receipt.sourceSha256 || typeof report.sourceUserId !== "string") return;
  if (report.sourceCatId === null) return null;
  if (!report.sourceCatId) return;
  const archived = tx.select().from(pgImportArchive).where(and(
    eq(pgImportArchive.sourceTable, "cats"), eq(pgImportArchive.reason, "world_and_soul_pending"),
    eq(pgImportArchive.sourceKey, report.sourceCatId),
  )).get();
  const cat = archived && decodeArchive(archived);
  if (cat?.id !== report.sourceCatId || cat.user_id !== report.sourceUserId) return;
  const sessions = tx.select().from(pgImportArchive).where(and(
    eq(pgImportArchive.sourceTable, "world_sessions"), eq(pgImportArchive.reason, "world_and_soul_pending"),
  )).limit(2).all();
  const old = mapLegacyWorld(cat, sessions.length === 1 ? decodeArchive(sessions[0]!) : undefined);
  return old && { ...old, userId: report.sourceUserId };
}
