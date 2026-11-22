import { and, asc, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { uuidv7 } from "../ids/index.ts";
import { getHostMeta } from "./host-meta.ts";
import { createDevice, getHousehold, getMember, revokeDevice } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { devices, hosts, members, pairingCodes } from "./schema/identity.ts";
import { failedCode, generateCode, hashCode, liveCode, normalizeCode } from "./codes.ts";

export { CODE_MAX_FAILURES as PAIRING_MAX_FAILURES, normalizeCode as normalizePairingCode } from "./codes.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;

function wallMs(clock: Clock): number {
  const now = clock.wallMs();
  validateWallMs(now);
  return now;
}

const active = (now: number) => liveCode(pairingCodes, now);

export function issuePairingCode(db: StoreDb, clock: Clock, memberId: string) {
  return db.transaction((tx) => {
    const member = getMember(tx, memberId);
    const host = tx.select().from(hosts).where(and(
      eq(hosts.id, getHostMeta(tx, "host_id") ?? ""), isNull(hosts.deletedAt),
    )).get();
    if (!host || !member || member.homeHostId !== host.id
      || member.householdId !== host.householdId || !getHousehold(tx, member.householdId)) {
      throw new TypeError("配对码必须绑定本机归属的有效成员");
    }
    const { code, codeHash } = generateCode((hash) => tx.select({ id: pairingCodes.id }).from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hash)).get() !== undefined);
    const now = wallMs(clock);
    const expiresAt = now + PAIRING_TTL_MS;
    validateWallMs(expiresAt);
    tx.insert(pairingCodes).values({
      id: uuidv7(clock), memberId, codeHash, expiresAt, usedAt: null, failures: 0, createdAt: now,
    }).run();
    return { code, expiresAt };
  }, { behavior: "immediate" });
}

export function redeemPairingCode(db: StoreDb, clock: Clock, input: { code: string; deviceName: string }) {
  const normalized = normalizeCode(input.code);
  if (!normalized || !input.deviceName.trim() || input.deviceName.length > 100) {
    throw new TypeError("配对请求格式无效");
  }
  return db.transaction((tx) => {
    const now = wallMs(clock);
    const code = tx.select().from(pairingCodes).where(and(active(now), eq(pairingCodes.codeHash, hashCode(normalized)))).get();
    const member = code ? getMember(tx, code.memberId) : undefined;
    const household = member ? getHousehold(tx, member.householdId) : undefined;
    const hostId = getHostMeta(tx, "host_id");
    const host = hostId ? tx.select().from(hosts).where(and(eq(hosts.id, hostId), isNull(hosts.deletedAt))).get() : undefined;
    if (!code || !member || !household || !host || member.homeHostId !== host.id || host.householdId !== household.id) {
      tx.update(pairingCodes).set(failedCode(pairingCodes)).where(active(now)).run();
      return undefined;
    }
    tx.update(pairingCodes).set({ usedAt: now }).where(eq(pairingCodes.id, code.id)).run();
    const issued = createDevice(tx, clock, { memberId: member.id, hostId: host.id, name: input.deviceName.trim() });
    return {
      ...issued,
      member: { id: member.id, householdId: member.householdId, displayName: member.displayName, homeHostId: member.homeHostId },
      household: { id: household.id, name: household.name },
    };
  }, { behavior: "immediate" });
}

export function listPairedDevices(db: StoreDb) {
  return db.select({
    id: devices.id, member_id: devices.memberId, name: devices.name,
    created_at: devices.createdAt, last_seen_at: devices.lastSeenAt,
  }).from(devices).innerJoin(members, eq(devices.memberId, members.id)).where(and(
    eq(devices.hostId, getHostMeta(db, "host_id") ?? ""), isNull(devices.revokedAt),
    isNull(devices.deletedAt), isNull(members.deletedAt),
  )).orderBy(asc(devices.id)).all();
}

export function revokeLocalDevice(db: StoreDb, clock: Clock, deviceId: string): boolean {
  return db.transaction((tx) => {
    const device = tx.select({ id: devices.id }).from(devices).where(and(
      eq(devices.id, deviceId), eq(devices.hostId, getHostMeta(tx, "host_id") ?? ""),
    )).get();
    return device ? revokeDevice(tx, clock, device.id) : false;
  }, { behavior: "immediate" });
}
