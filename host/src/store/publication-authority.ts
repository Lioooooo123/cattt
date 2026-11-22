import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { PublicationWindow } from "../publication/window.ts";
import type { GroupPublicationAuthority } from "../router/types.ts";
import { getHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { publicationCredential, readPublicationRoute } from "./publication.ts";
import { conversations } from "./schema/conversations.ts";
import { households, hosts, members } from "./schema/identity.ts";

type Reader = Pick<StoreDb, "select">;
type Conversation = Pick<typeof conversations.$inferSelect,
  "id" | "householdId" | "kind" | "ownerMemberId" | "publisherHostId">;

export function publicationEpoch(
  db: Reader, clock: Clock, conversation: Conversation, authority?: GroupPublicationAuthority, window?: PublicationWindow,
): string | undefined {
  const hostId = getHostMeta(db, "host_id");
  if (!hostId) return;
  const active = db.select({ id: hosts.id }).from(hosts)
    .innerJoin(households, eq(households.id, hosts.householdId)).where(and(
      eq(hosts.id, hostId), eq(households.id, conversation.householdId),
      isNull(hosts.deletedAt), isNull(households.deletedAt),
    )).get();
  if (!active) return;
  if (conversation.kind === "direct") {
    const owner = conversation.ownerMemberId && db.select({ homeHostId: members.homeHostId }).from(members).where(and(
      eq(members.id, conversation.ownerMemberId),
      eq(members.householdId, conversation.householdId), isNull(members.deletedAt),
    )).get();
    return owner && owner.homeHostId === hostId ? "direct" : undefined;
  }
  if (authority) {
    const epoch = conversation.publisherHostId === hostId && authority.currentEpoch(db, {
      hostId, householdId: conversation.householdId, conversationId: conversation.id, now: clock.wallMs(),
    });
    return epoch ? `leased:${epoch}` : undefined;
  }
  const { status, current } = readPublicationRoute(db, conversation.householdId, window);
  return status === "ready" && current ? publicationCredential(current) : undefined;
}

export function currentConversationEpoch(
  db: Reader, clock: Clock, conversationId: string, authority?: GroupPublicationAuthority, window?: PublicationWindow,
) {
  const conversation = db.select().from(conversations)
    .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt))).get();
  return conversation && publicationEpoch(db, clock, conversation, authority, window);
}
