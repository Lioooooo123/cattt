import { and, asc, desc, eq, inArray, like, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { PublicationProof } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { catFactKey, catFactSchema } from "../soul/facts.ts";
import type { CatFact, FactsOf } from "../soul/facts.ts";
import { businessRow } from "./business.ts";
import { catFactReplica } from "./cat-fact-replica.ts";
import type { CatFactRow } from "./cat-fact-replica.ts";
import type { StoreDb } from "./index.ts";
import { requireSharedPublisher } from "./publication.ts";
import { appendNativeChange } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { catFacts } from "./schema/cat-facts.ts";

export type CatReader = Pick<StoreDb, "select">;
type FactRow<K extends CatFact["type"]> = CatFactRow & { fact: FactsOf<K> };

export function readCatFacts<K extends CatFact["type"]>(
  db: CatReader, catId: string, kind: K, options: { ids?: string[]; prefix?: string } = {},
) {
  return db.select().from(catFacts).where(and(
    eq(catFacts.catId, catId), eq(catFacts.kind, kind), options.ids && inArray(catFacts.id, options.ids),
    options.prefix ? like(catFacts.key, `${options.prefix}%`) : undefined,
  )).all() as FactRow<K>[];
}

export function diaryPlanProgress(db: CatReader, catId: string) {
  const plan = and(eq(catFacts.catId, catId), eq(catFacts.kind, "diary_plan"));
  const entries = alias(catFacts, "written");
  const published = db.select({ id: entries.id }).from(entries).where(and(
    eq(entries.catId, catFacts.catId), eq(entries.kind, "daily_diary"), eq(entries.key, catFacts.key),
  ));
  const latest = db.select({ day: catFacts.key }).from(catFacts)
    .where(plan).orderBy(desc(catFacts.key)).limit(1).get()?.day;
  const pending = db.select({ day: catFacts.key }).from(catFacts).where(and(plan, notExists(published)))
    .orderBy(asc(catFacts.key)).limit(32).all().map(({ day }) => day);
  return { latest, pending };
}

export function readCatFact<K extends CatFact["type"]>(db: CatReader, catId: string, kind: K, key: string) {
  return db.select().from(catFacts).where(and(
    eq(catFacts.catId, catId), eq(catFacts.kind, kind), eq(catFacts.key, key),
  )).get() as FactRow<K> | undefined;
}

export function saveCatFact(
  tx: ReplicationTx, ctx: HostContext, captured: PublicationProof, catId: string, fact: CatFact,
) {
  const proof = requireSharedPublisher(tx, captured.householdId, ctx.publication, captured);
  const canonical = catFactSchema.parse(fact);
  const row: CatFactRow = {
    ...businessRow(ctx.clock, proof.holderHostId), householdId: proof.householdId, catId,
    epoch: proof.epoch, grantId: proof.grantId, kind: fact.type, key: catFactKey(canonical), fact: canonical,
  };
  tx.insert(catFacts).values(row).run();
  appendNativeChange(tx, proof.holderHostId, proof.householdId, catFactReplica, row);
  return row;
}
