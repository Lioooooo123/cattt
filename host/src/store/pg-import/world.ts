import { ImportError } from "../../import-pg/snapshot.ts";
import { publicationProof } from "../publication.ts";
import { mapLegacyWorld, seedWorld } from "../world-state.ts";
import { checked } from "./audit.ts";
import type { ImportContext } from "./context.ts";

export function importWorld(ctx: ImportContext) {
  const { tx, householdId, snapshot, rows, business, audit } = ctx;
  const [cat] = rows("cats");
  if (!cat) return;
  const [observation] = rows("world_sessions");
  if (cat.key !== snapshot.catId || cat.data.user_id !== snapshot.userId) {
    throw new ImportError("旧猫的归属无法证明");
  }
  const old = mapLegacyWorld(cat.data, observation?.data);
  if (!old) throw new ImportError("旧猫的基本资料无法映射");
  const proof = publicationProof(tx, householdId)!;
  const world = seedWorld(tx, proof, business("world-cat", cat.key, old.adoptedAt),
    business("world", cat.key, old.adoptedAt, old.observedAt ?? old.adoptedAt), old.profile, old);
  const catRecord = checked("world_cats", world.cat, world.persistedCat);
  const stateRecord = checked("world_states", world.state, world.persistedState);
  audit.mapped("cats", cat, [catRecord, stateRecord], [
    "id", "user_id", "persona_version", "allow_proactive", "proactive_revision",
    "learn_memories", "use_memories", "memory_revision", "learn_after_seq",
  ]);
  if (observation && old.snapshot) {
    audit.mapped("world_sessions", observation, [stateRecord], ["id", "generation", "state_version", "snapshot", "online_until"]);
  }
}
