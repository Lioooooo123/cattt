import { eq } from "drizzle-orm";
import type { StoreDb } from "./index.ts";
import { hostMeta } from "./schema/index.ts";

export function getHostMeta(db: Pick<StoreDb, "select">, key: string): string | undefined {
  return db.select().from(hostMeta).where(eq(hostMeta.key, key)).get()?.value;
}

export function requireLocalHostId(db: Pick<StoreDb, "select">): string {
  const hostId = getHostMeta(db, "host_id");
  if (!hostId) {
    throw new Error("宿主身份尚未初始化");
  }
  return hostId;
}

export function setHostMeta(db: Pick<StoreDb, "insert">, key: string, value: string): void {
  db.insert(hostMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: hostMeta.key, set: { value } })
    .run();
}
