import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { households } from "./identity.ts";
import { worldCats } from "./world.ts";

// Confirmations and observations are shared facts. The run/attempt belongs to local jobs.
export const catFacts = sqliteTable("cat_facts", {
  ...businessColumns(),
  householdId: text("household_id").notNull().references(() => households.id),
  catId: text("cat_id").notNull().references(() => worldCats.id),
  epoch: integer("epoch").notNull(),
  grantId: text("grant_id").notNull(),
  kind: text("kind").notNull(),
  key: text("business_key").notNull(),
  fact: text("fact", { mode: "json" }).notNull(),
}, (table) => [
  uniqueIndex("cat_facts_business").on(table.catId, table.kind, table.key),
  index("cat_facts_publication").on(table.householdId, table.epoch),
]);
