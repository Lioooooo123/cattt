import { integer, text } from "drizzle-orm/sqlite-core";

export function businessColumns() {
  return {
    id: text("id").primaryKey(),
    originHostId: text("origin_host_id").notNull(),
    hlc: text("hlc").notNull(),
    rev: integer("rev").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  };
}
