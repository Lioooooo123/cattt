import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { PublicationProof } from "../publication/types.ts";
import { parseHlc } from "../clock/index.ts";
import type { Conversation, Message, MessagePage } from "../conversations/types.ts";
import { canSeeConversation } from "../identity/access.ts";
import type { PublicationWindow } from "../publication/window.ts";
import { callsCat } from "../inference/rules.ts";
import type { HostConfig } from "../runtime/index.ts";
import { admitInference } from "./inference-intake.ts";
import { publicationEpoch } from "./publication-authority.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow, revision } from "./business.ts";
import { getHostMeta } from "./host-meta.ts";
import { appendNativeChange } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { publicationCredential, publicationProof, requireSharedPublisher } from "./publication.ts";
import { saveReplyKnowledge } from "./knowledge-use.ts";
import type { RecallEvidence } from "./knowledge-use.ts";
import { projectMessageReplica } from "./knowledge-replicas.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { StoreDb } from "./index.ts";
import { enqueueMessageExtraction } from "./memory-extraction.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";
import { turns } from "./schema/turns.ts";
import { createTurn, initialTurn } from "./turn-writes.ts";
import type { Append, TurnRow } from "./turn-writes.ts";

export class ConversationNotFoundError extends Error {}
export class NotPublisherError extends Error {}
export class IdempotencyConflictError extends Error {}
export class InvalidChatRequestError extends Error {}

type Reader = Pick<StoreDb, "select">;
type MessageRow = typeof messages.$inferSelect;
interface MessageKey { hlc: string; id: string }

function cursor(key: MessageKey): string {
  return `m1.${Buffer.from(JSON.stringify([key.hlc, key.id])).toString("base64url")}`;
}

function parseCursor(value: string): MessageKey {
  try {
    if (value.length > 256 || !/^m1\.[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }
    const raw = Buffer.from(value.slice(3), "base64url");
    if (raw.toString("base64url") !== value.slice(3)) {
      throw new Error();
    }
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed[1])) {
      throw new Error();
    }
    parseHlc(parsed[0]);
    const key = { hlc: parsed[0], id: parsed[1] };
    if (cursor(key) !== value) {
      throw new Error();
    }
    return key;
  } catch {
    throw new InvalidChatRequestError("消息游标无效");
  }
}

function before(key: MessageKey) {
  return or(lt(messages.hlc, key.hlc), and(eq(messages.hlc, key.hlc), lt(messages.id, key.id)));
}

function after(key: MessageKey) {
  return or(gt(messages.hlc, key.hlc), and(eq(messages.hlc, key.hlc), gt(messages.id, key.id)));
}

function dto(row: MessageRow): Message {
  return {
    id: row.id, conversation_id: row.conversationId, cursor: cursor(row),
    author: row.authorMemberId === null ? { kind: "cat" } : { kind: "member", member_id: row.authorMemberId },
    text: row.text, modality: row.modality, status: row.status, client_message_id: row.clientMessageId,
    reply_to_message_id: row.replyToMessageId, turn_id: row.turnId, created_at: row.createdAt,
  };
}

export { dto as messageDto };

function readParticipantIds(db: Reader, id: string, householdId: string): string[] {
  return db.select({ id: participants.memberId }).from(participants)
    .innerJoin(members, eq(participants.memberId, members.id)).where(and(
      eq(participants.conversationId, id), isNull(participants.deletedAt), isNull(members.deletedAt),
      eq(members.householdId, householdId),
    )).orderBy(asc(participants.memberId)).all().map((row) => row.id);
}

export function readConversationScope(db: Reader, id: string) {
  const conversation = db.select().from(conversations).where(and(eq(conversations.id, id), isNull(conversations.deletedAt))).get();
  return conversation && { ...conversation, participantMemberIds: readParticipantIds(db, id, conversation.householdId) };
}

export function visibleConversation(db: Reader, actor: Actor, id: string) {
  const conversation = readConversationScope(db, id);
  if (!conversation) {
    throw new ConversationNotFoundError();
  }
  const owner = conversation.ownerMemberId ? db.select().from(members).where(and(
    eq(members.id, conversation.ownerMemberId), isNull(members.deletedAt),
  )).get() : undefined;
  if (!canSeeConversation(actor, conversation) || (conversation.kind === "direct"
    && (!owner || owner.householdId !== conversation.householdId))) {
    throw new ConversationNotFoundError();
  }
  const publisherHostId = conversation.kind === "group"
    ? publicationProof(db, conversation.householdId)?.holderHostId ?? conversation.publisherHostId
    : owner!.homeHostId;
  return { ...conversation, publisherHostId };
}

export { visibleConversation as assertConversationAccess };

function conversationDto(db: Reader, row: ReturnType<typeof visibleConversation>): Conversation {
  const last = db.select().from(messages).where(and(
    eq(messages.conversationId, row.id), isNull(messages.deletedAt),
  )).orderBy(desc(messages.hlc), desc(messages.id)).limit(1).get();
  return {
    id: row.id, kind: row.kind, owner_member_id: row.ownerMemberId,
    participant_member_ids: row.participantMemberIds, publisher_host_id: row.publisherHostId,
    created_at: row.createdAt, last_message: last ? dto(last) : null,
  };
}

export function getConversation(db: Pick<StoreDb, "transaction">, actor: Actor, id: string): Conversation {
  return db.transaction((tx) => conversationDto(tx, visibleConversation(tx, actor, id)));
}

export function canReadConversation(db: Reader, actor: Actor, id: string): boolean {
  try {
    visibleConversation(db, actor, id);
    return true;
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return false;
    }
    throw error;
  }
}

/** 设备只可操作可见会话里自己发出的消息，包括已撤回知识用途的原话。 */
export function getOwnedConversationMessage(db: Reader, actor: Actor, conversationId: string, messageId: string) {
  if (!canReadConversation(db, actor, conversationId)) {
    return undefined;
  }
  return db.select().from(messages).where(and(
    eq(messages.conversationId, conversationId), eq(messages.id, messageId),
    eq(messages.authorMemberId, actor.memberId), isNull(messages.deletedAt), eq(messages.status, "complete"),
  )).get();
}

function readableConversations(db: Reader, actor: Actor) {
  const rows = db.select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.householdId, actor.householdId), isNull(conversations.deletedAt),
    or(eq(conversations.kind, "group"), eq(conversations.ownerMemberId, actor.memberId)),
  )).all();
  return rows.flatMap(({ id }) => {
    try {
      return [visibleConversation(db, actor, id)];
    } catch (error) {
      if (!(error instanceof ConversationNotFoundError)) {
        throw error;
      }
      return [];
    }
  });
}

export function listReadableConversationIds(db: Reader, actor: Actor): string[] {
  return readableConversations(db, actor).map(({ id }) => id);
}

export function listConversations(db: Pick<StoreDb, "transaction">, actor: Actor): Conversation[] {
  return db.transaction((tx) => readableConversations(tx, actor)
    .map((row) => conversationDto(tx, row))
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "group" ? -1 : 1)));
}

export function readMessages(
  db: Pick<StoreDb, "transaction">, actor: Actor, conversationId: string,
  input: { before?: string; after?: string; limit?: number } = {},
): MessagePage {
  return db.transaction((tx) => {
    visibleConversation(tx, actor, conversationId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidChatRequestError("分页大小须为 1 至 100");
    }
    const lower = input.after === undefined ? undefined : parseCursor(input.after);
    const upper = input.before === undefined ? undefined : parseCursor(input.before);
    const base = and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt));
    const rows = tx.select().from(messages).where(and(base, lower ? after(lower) : undefined, upper ? before(upper) : undefined))
      .orderBy(lower ? asc(messages.hlc) : desc(messages.hlc), lower ? asc(messages.id) : desc(messages.id)).limit(limit).all();
    if (!lower) {
      rows.reverse();
    }
    const first = rows[0];
    const last = rows.at(-1);
    const hasBefore = first ? before(first) : lower ? or(lt(messages.hlc, lower.hlc), and(eq(messages.hlc, lower.hlc), lte(messages.id, lower.id))) : undefined;
    const hasAfter = last ? after(last) : upper ? or(gt(messages.hlc, upper.hlc), and(eq(messages.hlc, upper.hlc), gte(messages.id, upper.id))) : undefined;
    return {
      messages: rows.map(dto),
      has_more_before: hasBefore !== undefined && tx.select({ id: messages.id }).from(messages).where(and(base, hasBefore)).limit(1).get() !== undefined,
      has_more_after: hasAfter !== undefined && tx.select({ id: messages.id }).from(messages).where(and(base, hasAfter)).limit(1).get() !== undefined,
    };
  });
}

/** 轮次与 Router 共用持久消息写入。调用方在同一事务核对发布权限。 */
export function appendCatMessage(
  db: ReplicationTx, clock: Clock,
  input: Pick<MessageRow, "conversationId" | "text" | "replyToMessageId" | "turnId" | "status"> & { hostId: string; publicationEpoch?: number | null; knowledgeEvidence?: RecallEvidence[] },
): MessageRow {
  const { hostId, knowledgeEvidence, ...message } = input;
  const row = db.insert(messages).values({
    ...businessRow(clock, hostId), ...message, authorMemberId: null, modality: "text", clientMessageId: null,
  }).returning().get()!;
  const conversation = db.update(conversations).set({ ...revision(clock), rev: sql`${conversations.rev} + 1` })
    .where(eq(conversations.id, input.conversationId)).returning().get()!;
  saveReplyKnowledge(db, row.id, knowledgeEvidence ?? []);
  appendNativeChange(db, hostId, conversation.householdId, replicaAdapters.message, projectMessageReplica(db, row));
  return row;
}

export interface MemberMessageInput {
  conversationId: string;
  memberId: string;
  clientMessageId: string;
  text: string;
}

export type GroupReplyPolicy = (
  tx: ReplicationTx, clock: Clock, message: MessageRow, proof: PublicationProof, append?: Append, credential?: string,
) => TurnRow | undefined;

export const defaultGroupReply: GroupReplyPolicy = (tx, clock, message, proof, append, credential) =>
  createTurn(tx, clock, message.conversationId, message.id, null, append, credential ?? publicationCredential(proof));

export const quietGroupReply: GroupReplyPolicy = (tx, clock, message, proof, append, credential) =>
  callsCat(message.text) ? defaultGroupReply(tx, clock, message, proof, append, credential) : undefined;

type SendPolicy = Pick<HostConfig, "askOutcomeRule" | "groupPublicationAuthority">;

export function findMemberMessage(db: Reader, input: Omit<MemberMessageInput, "text">) {
  return db.select().from(messages).where(and(
    eq(messages.conversationId, input.conversationId), eq(messages.authorMemberId, input.memberId),
    eq(messages.clientMessageId, input.clientMessageId),
  )).get();
}

export function memberMessageResponse(db: Reader, row: MessageRow) {
  const original = row.turnId ? db.select().from(turns).where(eq(turns.id, row.turnId)).get() : undefined;
  return { message: dto(row), turn: original ? initialTurn(original) : null };
}

// Both device and peer admission must verify the sender and publication proof in this transaction.
export function publishMemberMessage(
  tx: ReplicationTx, clock: Clock, hostId: string, householdId: string, input: MemberMessageInput,
  append?: Append, proof?: PublicationProof, groupReply: GroupReplyPolicy = quietGroupReply, policy?: SendPolicy,
) {
  const { memberId, ...content } = input;
  const row = tx.insert(messages).values({
    ...businessRow(clock, hostId), ...content, authorMemberId: memberId, modality: "text",
    status: "complete", replyToMessageId: null, turnId: null, publicationEpoch: proof?.epoch ?? null,
  }).returning().get()!;
  appendNativeChange(tx, hostId, householdId, replicaAdapters.message, projectMessageReplica(tx, row));
  const scope = readConversationScope(tx, row.conversationId)!;
  const syntheticEpoch = proof && policy?.groupPublicationAuthority?.currentEpoch(tx, {
    hostId, householdId, conversationId: row.conversationId, now: clock.wallMs(),
  });
  const epoch = proof ? policy?.groupPublicationAuthority
    ? syntheticEpoch && `leased:${syntheticEpoch}` : publicationCredential(proof) : "direct";
  if (!epoch) throw new NotPublisherError();
  const turn = proof
    ? groupReply(tx, clock, row, proof, append, epoch)
    : createTurn(tx, clock, input.conversationId, row.id, null, append);
  if (turn) {
    tx.update(messages).set({ turnId: turn.id }).where(eq(messages.id, row.id)).run();
  }
  tx.update(conversations).set({ ...revision(clock), rev: sql`${conversations.rev} + 1` })
    .where(eq(conversations.id, row.conversationId)).run();
  enqueueMessageExtraction(tx, clock, {
    householdId, conversationId: row.conversationId, sourceMemberId: memberId,
    sourceMessageId: row.id, sourceRevision: row.rev,
  });
  admitInference(tx, row, scope, epoch, policy?.askOutcomeRule);
  return { message: dto({ ...row, turnId: turn?.id ?? null }), turn: turn ? initialTurn(turn) : null };
}

export function sendMessage(
  db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor, conversationId: string,
  input: { clientMessageId: string; text: string },
  append?: Append, window?: PublicationWindow, groupReply?: GroupReplyPolicy, policy?: SendPolicy,
) {
  const text = input.text.trim();
  if (input.clientMessageId.length < 1 || input.clientMessageId.length > 100 || text.length < 1 || text.length > 4000) {
    throw new InvalidChatRequestError("消息格式无效");
  }
  return db.transaction((tx) => {
    const conversation = visibleConversation(tx, actor, conversationId);
    const hostId = getHostMeta(tx, "host_id");
    if (!hostId || (conversation.kind === "direct" && conversation.publisherHostId !== hostId)) {
      throw new NotPublisherError();
    }
    const write = { conversationId, memberId: actor.memberId, clientMessageId: input.clientMessageId, text };
    const existing = findMemberMessage(tx, write);
    if (existing) {
      if (existing.deletedAt !== null) throw new ConversationNotFoundError();
      if (existing.text !== text) {
        throw new IdempotencyConflictError();
      }
      return { created: false, body: memberMessageResponse(tx, existing) };
    }
    const proof = conversation.kind !== "group" ? undefined
      : policy?.groupPublicationAuthority
        ? publicationEpoch(tx, clock, conversation, policy.groupPublicationAuthority)
          ? publicationProof(tx, conversation.householdId) : undefined
        : requireSharedPublisher(tx, conversation.householdId, window);
    if (conversation.kind === "group" && !proof) throw new NotPublisherError();
    return {
      created: true,
      body: publishMemberMessage(tx, clock, hostId, conversation.householdId, write, append, proof, groupReply, policy),
    };
  }, { behavior: "immediate" });
}
