import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL(existsSync(new URL('./drizzle', import.meta.url)) ? './drizzle' : '../drizzle', import.meta.url)),
  });
  console.log('数据库迁移完成');
} finally {
  await sql.end();
}
