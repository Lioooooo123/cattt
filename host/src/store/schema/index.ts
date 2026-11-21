import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const hostMeta = sqliteTable("host_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
