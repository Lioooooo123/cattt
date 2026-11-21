import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
const output = `import type { MigrationMeta } from "drizzle-orm/migrator";\n\n`
  + `export const migrations: MigrationMeta[] = ${JSON.stringify(migrations, null, 2)};\n`;

await Bun.write(new URL("../src/store/migrations.generated.ts", import.meta.url), output);
