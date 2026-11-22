import { eq } from "drizzle-orm";
import type { ReplicationSource } from "../replication/types.ts";
import { assertReplicaWriter, requireReplicaDependency } from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { households, hosts, members } from "./schema/identity.ts";

export function household(tx: ReplicationTx, id: string) {
  return requireReplicaDependency(
    tx.select().from(households).where(eq(households.id, id)).get(), "household", id,
  );
}

export function hostInHousehold(tx: ReplicationTx, id: string, householdId: string) {
  const host = requireReplicaDependency(tx.select().from(hosts).where(eq(hosts.id, id)).get(), "host", id);
  assertReplicaWriter(host.householdId === householdId);
  return host;
}

export function memberInHousehold(tx: ReplicationTx, id: string, householdId: string) {
  const member = requireReplicaDependency(tx.select().from(members).where(eq(members.id, id)).get(), "member", id);
  assertReplicaWriter(member.householdId === householdId);
  return member;
}

export function conversationInHousehold(tx: ReplicationTx, source: ReplicationSource, id: string) {
  const conversation = requireReplicaDependency(
    tx.select().from(conversations).where(eq(conversations.id, id)).get(), "conversation", id,
  );
  assertReplicaWriter(conversation.householdId === source.householdId);
  return conversation;
}

export function messageInHousehold(tx: ReplicationTx, source: ReplicationSource, id: string, author?: string) {
  const message = requireReplicaDependency(
    tx.select().from(messages).where(eq(messages.id, id)).get(), "message", id,
  );
  const conversation = conversationInHousehold(tx, source, message.conversationId);
  assertReplicaWriter(author === undefined || message.authorMemberId === author);
  return { message, conversation };
}
