import { and, eq, gt } from "drizzle-orm";
import { encodeHlc } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import type { StoreDb } from "./index.ts";
import { leases } from "./schema/index.ts";

export const DEFAULT_LEASE_SKEW_MS = 5000;
export type Lease = typeof leases.$inferSelect;

export interface AcquireLease {
  name: string;
  holder: string;
  ttlMs: number;
  skewMs?: number;
}

export interface LeaseResult {
  acquired: boolean;
  epoch: number;
  holder: string;
  expiresAt: number;
}

export class LeaseLostError extends Error {
  constructor(
    public readonly leaseName: string,
    public readonly holder: string,
    public readonly epoch: number,
  ) {
    super(`租约已失效：${leaseName}`);
    this.name = "LeaseLostError";
  }
}

function expiresAt(clock: Clock, ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError("租期必须是正整数毫秒");
  }
  const now = clock.wallMs();
  validateWallMs(now);
  validateWallMs(now + ttlMs);
  return { now, expiry: now + ttlMs };
}

export function getLease(db: Pick<StoreDb, "select">, name: string): Lease | undefined {
  return db.select().from(leases).where(eq(leases.name, name)).get();
}

export function acquireLease(db: StoreDb, clock: Clock, input: AcquireLease): LeaseResult {
  const skewMs = input.skewMs ?? DEFAULT_LEASE_SKEW_MS;
  if (!input.name || !input.holder || !Number.isSafeInteger(skewMs) || skewMs < 0) {
    throw new RangeError("租约名称和持有者不能为空，时钟宽限须为非负整数");
  }
  return db.transaction((tx) => {
    const { now, expiry } = expiresAt(clock, input.ttlMs);
    const previous = getLease(tx, input.name);
    const released = previous?.expiresAt === 0;
    if (previous && !released && previous.holder !== input.holder
      && now - previous.expiresAt <= skewMs) {
      return {
        acquired: false,
        epoch: previous.epoch,
        holder: previous.holder,
        expiresAt: previous.expiresAt,
      };
    }
    const sameHolder = previous && !released && previous.holder === input.holder;
    const epoch = sameHolder ? previous.epoch : (previous?.epoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch)) {
      throw new RangeError("租约 fencing token 超出范围");
    }
    const row: Lease = {
      name: input.name,
      holder: input.holder,
      epoch,
      acquiredHlc: sameHolder ? previous.acquiredHlc : encodeHlc(clock.hlc()),
      expiresAt: expiry,
      updatedAt: now,
    };
    tx.insert(leases).values(row).onConflictDoUpdate({ target: leases.name, set: row }).run();
    return { acquired: true, epoch, holder: input.holder, expiresAt: expiry };
  }, { behavior: "immediate" });
}

export function renewLease(
  db: StoreDb,
  clock: Clock,
  name: string,
  holder: string,
  epoch: number,
  ttlMs: number,
): boolean {
  return db.transaction((tx) => {
    const { now, expiry } = expiresAt(clock, ttlMs);
    return tx.update(leases).set({ expiresAt: expiry, updatedAt: now }).where(and(
      eq(leases.name, name),
      eq(leases.holder, holder),
      eq(leases.epoch, epoch),
      gt(leases.expiresAt, now),
    )).returning({ name: leases.name }).get() !== undefined;
  }, { behavior: "immediate" });
}

export function releaseLease(
  db: StoreDb,
  clock: Clock,
  name: string,
  holder: string,
  epoch: number,
): boolean {
  return db.transaction((tx) => {
    const now = clock.wallMs();
    validateWallMs(now);
    return tx.update(leases).set({ expiresAt: 0, updatedAt: now }).where(and(
      eq(leases.name, name),
      eq(leases.holder, holder),
      eq(leases.epoch, epoch),
      gt(leases.expiresAt, 0),
    )).returning({ name: leases.name }).get() !== undefined;
  }, { behavior: "immediate" });
}

export function assertLeaseHeld(
  db: Pick<StoreDb, "select">,
  clock: Clock,
  name: string,
  holder: string,
  epoch: number,
): void {
  const now = clock.wallMs();
  validateWallMs(now);
  const lease = getLease(db, name);
  if (!lease || lease.holder !== holder || lease.epoch !== epoch || lease.expiresAt <= now) {
    throw new LeaseLostError(name, holder, epoch);
  }
}
