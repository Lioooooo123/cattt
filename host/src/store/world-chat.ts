import { and, desc, eq, isNull } from "drizzle-orm";
import type { Actor } from "../identity/index.ts";
import { PublicationLeaseError } from "../publication/types.ts";
import type { PublicationProof } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { WorldError } from "../world/protocol.ts";
import type { SessionIdentity } from "../world/protocol.ts";
import { isActiveDeviceActor } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { requireSharedPublisher } from "./publication.ts";
import { messages } from "./schema/conversations.ts";
import { worldActions } from "./schema/world.ts";
import { chatWorldDriver, requestWorldAction } from "./world.ts";

export type ChatWorldDb = Pick<StoreDb, "select" | "transaction">;
export type ChatWorldAuthority = { proof: PublicationProof; session: SessionIdentity };

export function captureChatWorldAuthority(ctx: HostContext, actor: Actor): ChatWorldAuthority | undefined {
  const db = ctx.store.db;
  try {
    const proof = requireSharedPublisher(db, actor.householdId, ctx.publication);
    const driver = chatWorldDriver(db, actor, proof, ctx.clock.wallMs());
    if (driver) return { proof, session: driver.identity };
  } catch (error) {
    if (!(error instanceof PublicationLeaseError || error instanceof WorldError)) throw error;
  }
}

export function observeChatWorldDriver(ctx: HostContext, actor: Actor, authority: ChatWorldAuthority) {
  const db = ctx.store.db;
  const proof = requireSharedPublisher(db, actor.householdId, ctx.publication, authority.proof);
  return chatWorldDriver(db, actor, proof, ctx.clock.wallMs(), authority.session);
}

export function requestChatWorldAction(
  ctx: HostContext, actor: Actor, authority: ChatWorldAuthority, input: Parameters<typeof requestWorldAction>[2],
  assertCurrent: (db: ChatWorldDb) => void,
) {
  return ctx.store.db.transaction((tx) => {
    assertCurrent(tx);
    requireSharedPublisher(tx, actor.householdId, ctx.publication, authority.proof);
    return requestWorldAction(ctx, actor, { ...input, ...authority.session });
  }, { behavior: "immediate" });
}

// Chat commands use the source message UUID as the existing world request key.
export function chatWorldReceipt(
  db: Pick<StoreDb, "select">, actor: Actor, conversationId: string, source?: string,
) {
  if (!isActiveDeviceActor(db, actor)) return;
  return db.select({ id: worldActions.id }).from(worldActions)
    .innerJoin(messages, and(eq(messages.id, worldActions.requestId), eq(messages.authorMemberId, worldActions.memberId)))
    .where(and(eq(worldActions.householdId, actor.householdId), eq(worldActions.memberId, actor.memberId),
      eq(messages.conversationId, conversationId), isNull(messages.deletedAt), isNull(worldActions.deletedAt),
      source === undefined ? undefined : eq(messages.id, source)))
    .orderBy(desc(worldActions.createdAt), desc(worldActions.id)).get()?.id;
}
