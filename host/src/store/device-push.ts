import { and, eq, isNull, lte } from "drizzle-orm";
import type { Actor } from "../identity/index.ts";
import type { PushEnvironment } from "../push/apns.ts";
import type { HostContext } from "../runtime/index.ts";
import { isActiveDeviceActor, getMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { devices, members } from "./schema/identity.ts";
import { devicePushRegistrations } from "./schema/push.ts";

export type PushEnrollment = { token: string; environment: PushEnvironment; topic: string };
type Reader = Pick<StoreDb, "select">;

export function isHomeDevice(ctx: HostContext, db: Reader, actor: Actor): boolean {
  return actor.hostId === ctx.hostId && actor.householdId === ctx.householdId
    && isActiveDeviceActor(db, actor) && getMember(db, actor.memberId)?.homeHostId === ctx.hostId;
}

export function enrollPushDevice(ctx: HostContext, actor: Actor, input: PushEnrollment): "ok" | "forbidden" | "conflict" {
  return ctx.store.db.transaction((tx) => {
    if (!isHomeDevice(ctx, tx, actor)) return "forbidden";
    const existing = tx.select().from(devicePushRegistrations).where(and(
      eq(devicePushRegistrations.token, input.token), eq(devicePushRegistrations.environment, input.environment),
      eq(devicePushRegistrations.topic, input.topic),
    )).get();
    if (existing && existing.deviceId !== actor.deviceId) return "conflict";
    const updatedAt = ctx.clock.wallMs();
    const bindingId = existing?.bindingId ?? crypto.randomUUID();
    tx.insert(devicePushRegistrations).values({ deviceId: actor.deviceId, bindingId, updatedAt, ...input })
      .onConflictDoUpdate({ target: devicePushRegistrations.deviceId, set: { bindingId, updatedAt, ...input } }).run();
    return "ok";
  }, { behavior: "immediate" });
}

export function deletePushDevice(ctx: HostContext, actor: Actor): boolean {
  if (!isHomeDevice(ctx, ctx.store.db, actor)) return false;
  ctx.store.db.delete(devicePushRegistrations).where(eq(devicePushRegistrations.deviceId, actor.deviceId)).run();
  return true;
}

export function enrolledPushDevices(
  ctx: HostContext, db: Reader, memberId: string, topic: string,
) {
  return db.select({ registration: devicePushRegistrations }).from(devicePushRegistrations)
    .innerJoin(devices, eq(devicePushRegistrations.deviceId, devices.id))
    .innerJoin(members, eq(devices.memberId, members.id))
    .where(and(eq(devices.hostId, ctx.hostId), eq(devices.memberId, memberId),
      eq(members.householdId, ctx.householdId), eq(members.homeHostId, ctx.hostId),
      eq(devicePushRegistrations.topic, topic),
      isNull(devices.revokedAt), isNull(devices.deletedAt), isNull(members.deletedAt)))
    .orderBy(devices.id).all().map(({ registration }) => registration)
    .filter((registration) => isActiveDeviceActor(db, {
      deviceId: registration.deviceId, hostId: ctx.hostId, memberId, householdId: ctx.householdId,
    }));
}

export function invalidatePushBinding(
  db: Pick<StoreDb, "delete">, deviceId: string, bindingId: string, timestamp: number,
): void {
  db.delete(devicePushRegistrations).where(and(
    eq(devicePushRegistrations.deviceId, deviceId), eq(devicePushRegistrations.bindingId, bindingId),
    lte(devicePushRegistrations.updatedAt, timestamp),
  )).run();
}
