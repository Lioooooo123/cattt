import type { Database } from "bun:sqlite";
import { SQLiteBunSession } from "drizzle-orm/bun-sqlite/session";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { migrations } from "./migrations.generated.ts";

export function migrateStore(raw: Database): void {
  const dialect = new SQLiteSyncDialect();
  const session = new SQLiteBunSession(raw, dialect, undefined);
  dialect.migrate(migrations, session);
}
