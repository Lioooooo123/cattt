import { eq } from "drizzle-orm";
import type { StoreDb } from "./index.ts";
import { hostMeta } from "./schema/index.ts";

export function getHostMeta(db: Pick<StoreDb, "select">, key: string): string | undefined {
  return db.select().from(hostMeta).where(eq(hostMeta.key, key)).get()?.value;
}

export function setHostMeta(db: StoreDb, key: string, value: string): void {
  db.insert(hostMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: hostMeta.key, set: { value } })
    .run();
}
