import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { z } from "zod";
import { wallDate } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { uuidv7 } from "../ids/index.ts";
import type { PublicationProof } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import {
  canTransition, OBSERVATION_MS, PRESENCE_MS, STREAM_MS, terminalStatuses, WorldError,
} from "../world/protocol.ts";
import type {
  ackSchema, moveSchema, Profile, putStateSchema, SessionIdentity, WorldSnapshot,
} from "../world/protocol.ts";
import { projectBehavior, projectSnapshot } from "../world/wire.ts";
import { recordWorldObservation } from "./cat-diary.ts";
import { projectSoul } from "./soul.ts";
import { revision, businessRow } from "./business.ts";
import { getHousehold, isActiveDeviceActor } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { readPublicationRoute, requireSharedPublisher } from "./publication.ts";
import { appendNativeChange, atomicNativeChanges } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { devices, members } from "./schema/identity.ts";
import { worldActions, worldExecutors, worldSessions } from "./schema/world.ts";
import { worldReplicas } from "./world-replicas.ts";
import type { ActionRow } from "./world-replicas.ts";
import { behaviorForWorld, ensureWorld, projectWorld, readWorld, saveWorldState, worldRevision } from "./world-state.ts";

type Reader = Pick<StoreDb, "select">;
type LocalSession = Omit<typeof worldSessions.$inferSelect, "snapshot"> & { snapshot: WorldSnapshot | null };
const activeStatuses = ["requested", "accepted", "running"];

function activeActor(db: Reader, actor: Actor) {
  if (!isActiveDeviceActor(db, actor)) throw new WorldError("unauthorized", 401);
}

function ownedSession(db: Reader, actor: Actor, identity: SessionIdentity): LocalSession {
  activeActor(db, actor);
  const session = db.select().from(worldSessions).where(and(
    eq(worldSessions.id, identity.sessionId), eq(worldSessions.generation, identity.generation),
    eq(worldSessions.memberId, actor.memberId), eq(worldSessions.deviceId, actor.deviceId),
    eq(worldSessions.householdId, actor.householdId),
  )).get() as LocalSession | undefined;
  if (!session) throw new WorldError("session_replaced");
  return session;
}

export function resetWorldSessions(tx: Pick<StoreDb, "delete">) {
  tx.delete(worldExecutors).run();
  tx.delete(worldSessions).run();
}

export function localPresence(db: Reader, householdId: string, now: number) {
  return db.select({ member_id: members.id }).from(worldSessions)
    .innerJoin(members, eq(members.id, worldSessions.memberId))
    .innerJoin(devices, eq(devices.id, worldSessions.deviceId)).where(and(
      eq(worldSessions.householdId, householdId), gt(worldSessions.presentUntil, now),
      isNull(members.deletedAt), isNull(devices.deletedAt), isNull(devices.revokedAt),
    )).orderBy(members.id).all();
}

function currentDriver(db: Reader, proof: PublicationProof, now: number): LocalSession | undefined {
  const driver = db.select({ session: worldSessions }).from(worldSessions)
    .innerJoin(devices, eq(devices.id, worldSessions.deviceId))
    .innerJoin(members, eq(members.id, worldSessions.memberId)).where(and(
      eq(worldSessions.householdId, proof.householdId), eq(worldSessions.driveGrantId, proof.grantId),
      gt(worldSessions.presentUntil, now), gt(worldSessions.observedAt, now - OBSERVATION_MS),
      isNull(devices.revokedAt), isNull(devices.deletedAt), isNull(members.deletedAt),
    )).get()?.session as LocalSession | undefined;
  if (driver?.snapshot?.runnable && !driver.snapshot.paused) return driver;
}

export function chatWorldDriver(db: Reader, actor: Actor, proof: PublicationProof, now: number, expected?: SessionIdentity) {
  activeActor(db, actor);
  const driver = currentDriver(db, proof, now);
  if (!driver?.snapshot || driver.memberId !== actor.memberId || driver.deviceId !== actor.deviceId
    || driver.streamUntil <= now || expected && (driver.id !== expected.sessionId || driver.generation !== expected.generation)) return;
  return { identity: { sessionId: driver.id, generation: driver.generation }, snapshot: driver.snapshot };
}

export function worldView(ctx: HostContext, actor: Actor, db: Reader = ctx.store.db) {
  activeActor(db, actor);
  const now = ctx.clock.wallMs();
  const world = projectWorld(db, actor.householdId);
  const publication = readPublicationRoute(db, actor.householdId, ctx.publication);
  const driver = publication.status === "ready" && publication.current && currentDriver(db, publication.current, now);
  return {
    world, soul: projectSoul(db, actor, now), behavior: projectBehavior(behaviorForWorld(world, now)),
    server_time: wallDate(now).toISOString(),
    publication: { status: publication.status, publisher_host_id: publication.current?.holderHostId ?? null },
    execution_available: !!driver && driver.memberId === actor.memberId && driver.deviceId === actor.deviceId && driver.streamUntil > now,
    presence: localPresence(db, actor.householdId, now),
  };
}

export function registerWorldSession(ctx: HostContext, actor: Actor) {
  return ctx.store.db.transaction((tx) => {
    activeActor(tx, actor);
    const now = ctx.clock.wallMs();
    const publication = readPublicationRoute(tx, actor.householdId, ctx.publication);
    const proof = publication.status === "ready"
      ? requireSharedPublisher(tx, actor.householdId, ctx.publication, publication.current) : undefined;
    if (proof && getHousehold(tx, actor.householdId)?.originHostId === ctx.hostId) {
      ensureWorld(tx, ctx.clock, proof);
    }
    const sessionId = uuidv7(ctx.clock);
    const generation = uuidv7(ctx.clock);
    const session = {
      id: sessionId, generation, householdId: actor.householdId, memberId: actor.memberId, deviceId: actor.deviceId,
      presentUntil: now + PRESENCE_MS, streamUntil: 0, stateVersion: -1,
    };
    tx.delete(worldSessions).where(eq(worldSessions.memberId, actor.memberId)).run();
    tx.insert(worldSessions).values(session).run();
    if (proof) expireActions(tx, ctx, proof, now);
    return { session_id: sessionId, generation, ...worldView(ctx, actor, tx) };
  }, { behavior: "immediate" });
}

function observe(tx: ReplicationTx, session: LocalSession, snapshot: WorldSnapshot, now: number, proof: PublicationProof) {
  tx.update(worldSessions).set({
    presentUntil: now + PRESENCE_MS, snapshot, observedAt: now, stateVersion: snapshot.stateVersion, driveGrantId: proof.grantId,
  }).where(eq(worldSessions.id, session.id)).run();
}

function expireActions(tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, now: number) {
  const rows = tx.select({ action: worldActions, session: worldSessions })
    .from(worldActions).leftJoin(worldExecutors, eq(worldExecutors.actionId, worldActions.id))
    .leftJoin(worldSessions, eq(worldSessions.id, worldExecutors.sessionId)).where(and(
      eq(worldActions.householdId, proof.householdId), eq(worldActions.epoch, proof.epoch),
      inArray(worldActions.status, activeStatuses),
    )).all() as { action: ActionRow; session: LocalSession | null }[];
  for (const { action, session } of rows) {
    if (!session || !isActiveDeviceActor(tx, {
      memberId: session.memberId, deviceId: session.deviceId, hostId: ctx.hostId, householdId: proof.householdId,
    })) {
      saveAction(tx, ctx, proof, action, { status: "interrupted", reason: "session_replaced" });
    } else if (action.status === "requested" && action.acceptBefore <= now) {
      saveAction(tx, ctx, proof, action, { status: "expired", reason: "accept_timeout" });
    } else if (action.finishBefore <= now) {
      saveAction(tx, ctx, proof, action, { status: "expired", reason: "execution_timeout" });
    }
  }
}

function interruptActions(tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, reason: string) {
  const rows = tx.select().from(worldActions).where(and(
    eq(worldActions.householdId, proof.householdId), eq(worldActions.epoch, proof.epoch), inArray(worldActions.status, activeStatuses),
  )).all() as ActionRow[];
  for (const action of rows) saveAction(tx, ctx, proof, action, { status: "interrupted", reason });
}

function saveAction(tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, action: ActionRow,
  change: Partial<Pick<ActionRow, "status" | "reason" | "resultSnapshot" | "occurredAt">>,
) {
  const row: ActionRow = { ...action, ...change, ...revision(ctx.clock), rev: action.rev + 1 };
  tx.update(worldActions).set(row).where(eq(worldActions.id, row.id)).run();
  appendNativeChange(tx, proof.holderHostId, proof.householdId, worldReplicas.world_action, row);
  return row;
}

export function putWorldState(ctx: HostContext, actor: Actor, input: z.infer<typeof putStateSchema>) {
  return ctx.store.db.transaction((tx) => {
    const session = ownedSession(tx, actor, input);
    const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication);
    const world = ensureWorld(tx, ctx.clock, proof);
    const now = ctx.clock.wallMs();
    const snapshot = input.snapshot;
    if (snapshot.stateVersion < session.stateVersion) throw new WorldError("stale_state");
    const sameVersion = snapshot.stateVersion === session.stateVersion;
    if (sameVersion && !isDeepStrictEqual(snapshot, session.snapshot)) throw new WorldError("state_version_conflict");
    const driver = currentDriver(tx, proof, now);
    if (driver && driver.id !== session.id) throw new WorldError("world_driver_active");
    const sameWorld = sameVersion && session.driveGrantId === proof.grantId && isDeepStrictEqual(snapshot, world.state.snapshot);
    if (!sameWorld && input.baseRevision !== worldRevision(world.state)) throw new WorldError("world_revision_conflict");
    if (session.driveGrantId !== proof.grantId || tx.select({ id: worldSessions.id }).from(worldSessions).where(and(
      eq(worldSessions.householdId, actor.householdId), eq(worldSessions.driveGrantId, proof.grantId), ne(worldSessions.id, session.id),
    )).get()) {
      interruptActions(tx, ctx, proof, "world_driver_changed");
      tx.update(worldSessions).set({ driveGrantId: null }).where(and(
        eq(worldSessions.householdId, actor.householdId), ne(worldSessions.id, session.id),
      )).run();
    }
    expireActions(tx, ctx, proof, now);
    if (snapshot.paused || !snapshot.runnable) interruptActions(tx, ctx, proof, "world_paused");
    observe(tx, session, snapshot, now, proof);
    saveWorldState(tx, ctx.clock, proof, world, { profile: world.state.profile, snapshot, observedAt: now });
    recordWorldObservation(tx, ctx, proof, world.cat.id, snapshot, now);
    return worldView(ctx, actor, tx);
  }, { behavior: "immediate" });
}

export function putWorldProfile(ctx: HostContext, actor: Actor, baseRevision: string, profile: Profile) {
  return ctx.store.db.transaction((tx) => {
    activeActor(tx, actor);
    const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication);
    const world = ensureWorld(tx, ctx.clock, proof);
    if (worldRevision(world.state) !== baseRevision && !isDeepStrictEqual(world.state.profile, profile)) {
      throw new WorldError("world_revision_conflict");
    }
    saveWorldState(tx, ctx.clock, proof, world, {
      profile, snapshot: world.state.snapshot, observedAt: world.state.observedAt,
    });
    return worldView(ctx, actor, tx);
  }, { behavior: "immediate" });
}

function actionView(action: ActionRow, epoch: number, identity?: SessionIdentity, executorMissing = false) {
  const interrupted = !terminalStatuses.includes(action.status)
    && (action.epoch !== epoch ? "publication_changed" : executorMissing && "session_replaced");
  return {
    id: action.id,
    ...(identity && { session_id: identity.sessionId, generation: identity.generation }),
    member_id: action.memberId, request_id: action.requestId,
    destination_id: action.destinationId, activity: action.activity ?? undefined,
    state_version: action.stateVersion, status: interrupted ? "interrupted" : action.status,
    reason: interrupted || action.reason,
    accept_before: wallDate(action.acceptBefore).toISOString(), finish_before: wallDate(action.finishBefore).toISOString(),
    occurred_at: action.occurredAt === null ? null : wallDate(action.occurredAt).toISOString(),
    snapshot: projectSnapshot(action.resultSnapshot), revision: action.rev,
  };
}

export function requestWorldAction(ctx: HostContext, actor: Actor, input: z.infer<typeof moveSchema>) {
  return ctx.store.db.transaction((tx) => {
    const session = ownedSession(tx, actor, input);
    const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication);
    const now = ctx.clock.wallMs();
    const world = readWorld(tx, actor.householdId);
    const existing = tx.select().from(worldActions).where(and(
      eq(worldActions.householdId, actor.householdId), eq(worldActions.memberId, actor.memberId),
      eq(worldActions.requestId, input.requestId),
    )).get() as ActionRow | undefined;
    if (existing) {
      if (existing.destinationId !== input.destinationId || existing.activity !== (input.activity ?? null)) {
        throw new WorldError("action_already_requested");
      }
      expireActions(tx, ctx, proof, now);
      const latest = tx.select().from(worldActions).where(eq(worldActions.id, existing.id)).get() as ActionRow;
      return actionView(latest, proof.epoch);
    }
    if (!world || session.streamUntil <= now) throw new WorldError("world_offline");
    if (currentDriver(tx, proof, now)?.id !== session.id) throw new WorldError("world_stale");
    if (input.stateVersion !== session.stateVersion) throw new WorldError("stale_state");
    const snapshot = session.snapshot!;
    if (!snapshot.destinationIds.includes(input.destinationId)) throw new WorldError("unsupported_destination");
    if (input.activity === "sit" && snapshot.companionSeat !== input.destinationId) throw new WorldError("seat_unavailable");
    expireActions(tx, ctx, proof, now);
    if (tx.select({ id: worldActions.id }).from(worldActions).where(and(
      eq(worldActions.householdId, actor.householdId), eq(worldActions.epoch, proof.epoch), inArray(worldActions.status, activeStatuses),
    )).get()) throw new WorldError("world_busy");
    const row: ActionRow = {
      ...businessRow(ctx.clock, ctx.hostId), householdId: actor.householdId, catId: world.cat.id,
      epoch: proof.epoch, grantId: proof.grantId, memberId: actor.memberId, requestId: input.requestId,
      stateVersion: input.stateVersion, destinationId: input.destinationId, activity: input.activity ?? null,
      status: "requested", reason: null, acceptBefore: now + 5000, finishBefore: now + 60_000,
      occurredAt: null, resultSnapshot: null,
    };
    tx.insert(worldActions).values(row).run();
    tx.insert(worldExecutors).values({ actionId: row.id, sessionId: session.id }).run();
    appendNativeChange(tx, ctx.hostId, actor.householdId, worldReplicas.world_action, row);
    return actionView(row, proof.epoch, input);
  }, { behavior: "immediate" });
}

export function acknowledgeWorldAction(ctx: HostContext, actor: Actor, id: string, input: z.infer<typeof ackSchema>) {
  return ctx.store.db.transaction((tx) => {
    const session = ownedSession(tx, actor, input);
    const found = tx.select({ action: worldActions }).from(worldActions)
      .innerJoin(worldExecutors, eq(worldExecutors.actionId, worldActions.id)).where(and(
        eq(worldActions.id, id), eq(worldExecutors.sessionId, session.id), eq(worldActions.memberId, actor.memberId),
        eq(worldActions.householdId, actor.householdId),
      )).get()?.action as ActionRow | undefined;
    if (!found) throw new WorldError("not_found", 404);
    const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication, found);
    const now = ctx.clock.wallMs();
    const { status, snapshot } = input;
    expireActions(tx, ctx, proof, now);
    const action = tx.select().from(worldActions).where(eq(worldActions.id, id)).get() as ActionRow;
    if (found.status === status) return actionView(action, proof.epoch);
    const occurredAt = input.occurredAt ? Date.parse(input.occurredAt) : now;
    if (occurredAt > now) throw new WorldError("invalid_event_time");
    const completedInTime = occurredAt >= action.createdAt && occurredAt <= action.finishBefore;
    const recovered = status === "arrived" && action.status === "expired" && action.reason === "execution_timeout"
      && input.occurredAt !== undefined && completedInTime;
    if (!canTransition(action.status, status) && !recovered) throw new WorldError("invalid_transition");
    if (status === "arrived" && !completedInTime) throw new WorldError("invalid_event_time");
    if (snapshot.stateVersion < action.stateVersion || (status === "accepted" && snapshot.stateVersion < session.stateVersion)) {
      throw new WorldError("stale_state");
    }
    if (snapshot.stateVersion === session.stateVersion && !isDeepStrictEqual(snapshot, session.snapshot)) {
      throw new WorldError("state_version_conflict");
    }
    if (status === "accepted" && (snapshot.paused || !snapshot.runnable || snapshot.stateVersion !== action.stateVersion
      || currentDriver(tx, proof, now)?.id !== session.id)) throw new WorldError("world_changed");
    const moving = ["moving", "approaching", "exiting"].includes(snapshot.phase);
    if (status === "arrived" && (snapshot.currentDestinationId !== action.destinationId
      || snapshot.targetDestinationId !== action.destinationId || moving || snapshot.paused
      || (action.activity === "sit" && (snapshot.activity !== "sit" || snapshot.action !== "sit_idle" || snapshot.activityFallback !== false)))) {
      throw new WorldError("arrival_not_observed");
    }
    return atomicNativeChanges(tx, ctx.hostId, () => {
      // An arrival receipt can confirm an old occurrence without rewinding later observations.
      if (snapshot.stateVersion > session.stateVersion && session.driveGrantId === proof.grantId) {
        const world = readWorld(tx, actor.householdId)!;
        const observedAt = Math.max(occurredAt, session.observedAt ?? 0);
        observe(tx, session, snapshot, observedAt, proof);
        saveWorldState(tx, ctx.clock, proof, world, { profile: world.state.profile, snapshot, observedAt });
      }
      if (status === "arrived") recordWorldObservation(tx, ctx, proof, action.catId, snapshot, occurredAt);
      return actionView(saveAction(tx, ctx, proof, action, {
        status, reason: input.reason ?? null, resultSnapshot: snapshot, occurredAt,
      }), proof.epoch);
    });
  }, { behavior: "immediate" });
}

export function readWorldAction(ctx: HostContext, actor: Actor, id: string) {
  return ctx.store.db.transaction((tx) => {
    activeActor(tx, actor);
    const scope = and(eq(worldActions.id, id), eq(worldActions.householdId, actor.householdId),
      eq(worldActions.memberId, actor.memberId));
    const found = tx.select().from(worldActions).where(scope).get() as ActionRow | undefined;
    if (!found) throw new WorldError("not_found", 404);
    const route = readPublicationRoute(tx, actor.householdId, ctx.publication);
    let action = found;
    if (route.status === "ready" && route.current?.epoch === found.epoch && !terminalStatuses.includes(found.status)) {
      const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication, found);
      expireActions(tx, ctx, proof, ctx.clock.wallMs());
      action = tx.select().from(worldActions).where(scope).get() as ActionRow;
    }
    const executorMissing = action.originHostId === ctx.hostId && !tx.select({ id: worldSessions.id }).from(worldSessions)
      .innerJoin(worldExecutors, eq(worldExecutors.sessionId, worldSessions.id)).where(eq(worldExecutors.actionId, id)).get();
    return actionView(action, route.current?.epoch ?? action.epoch, undefined, executorMissing);
  }, { behavior: "immediate" });
}

export function pollWorld(ctx: HostContext, actor: Actor, identity: SessionIdentity) {
  return ctx.store.db.transaction((tx) => {
    const session = ownedSession(tx, actor, identity);
    const now = ctx.clock.wallMs();
    tx.update(worldSessions).set({ presentUntil: now + PRESENCE_MS, streamUntil: now + STREAM_MS })
      .where(eq(worldSessions.id, session.id)).run();
    const route = readPublicationRoute(tx, actor.householdId, ctx.publication);
    const proof = route.status === "ready" ? requireSharedPublisher(tx, actor.householdId, ctx.publication, route.current) : undefined;
    if (proof) expireActions(tx, ctx, proof, now);
    const canDrive = proof && currentDriver(tx, proof, now)?.id === session.id;
    const statuses = tx.select().from(worldActions).where(and(
      eq(worldActions.householdId, actor.householdId), eq(worldActions.memberId, actor.memberId),
    )).orderBy(desc(worldActions.updatedAt), desc(worldActions.id)).limit(50).all() as ActionRow[];
    const requested = !canDrive ? [] : tx.select({ action: worldActions }).from(worldActions)
      .innerJoin(worldExecutors, eq(worldExecutors.actionId, worldActions.id)).where(and(
        eq(worldExecutors.sessionId, session.id), eq(worldActions.status, "requested"),
        eq(worldActions.epoch, proof.epoch),
      )).all().map(({ action }) => actionView(action as ActionRow, proof.epoch, identity));
    return {
      view: worldView(ctx, actor, tx), requested,
      statuses: statuses.map((action) => actionView(action, route.current?.epoch ?? action.epoch)),
    };
  }, { behavior: "immediate" });
}
