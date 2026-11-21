import { expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { migrations } from "../src/store/migrations.generated.ts";

test("内嵌迁移与 drizzle SQL、日志和哈希完全一致", () => {
  const authored = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  expect(migrations).toEqual(authored);
});
