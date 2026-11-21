import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema/index.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openStore(path: string) {
  const raw = new Database(path, { create: true, strict: true });

  try {
    raw.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      raw.exec("PRAGMA journal_mode = WAL");
    }
    raw.exec("PRAGMA synchronous = NORMAL");
    raw.exec("PRAGMA foreign_keys = ON");

    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder });

    return {
      db,
      raw,
      close() {
        raw.close();
      },
    };
  } catch (error) {
    raw.close();
    throw error;
  }
}

export type Store = ReturnType<typeof openStore>;
export type StoreDb = Store["db"];

export function writeTransaction<T>(store: Store, write: (db: StoreDb) => T): T {
  return store.raw.transaction(() => {
    const result = write(store.db);
    if (result instanceof Promise) {
      throw new TypeError("写事务回调必须同步执行");
    }
    return result;
  }).immediate();
}
