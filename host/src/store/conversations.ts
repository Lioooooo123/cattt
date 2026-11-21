import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { parseHlc } from "../clock/index.ts";
import type { Conversation, Message, MessagePage } from "../conversations/types.ts";
import { canSeeConversation } from "../identity/access.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow, revision } from "./business.ts";
import { getHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";

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

function visible(db: Reader, actor: Actor, id: string) {
  const conversation = db.select().from(conversations).where(and(eq(conversations.id, id), isNull(conversations.deletedAt))).get();
  if (!conversation) {
    throw new ConversationNotFoundError();
  }
  const participantMemberIds = db.select({ id: participants.memberId }).from(participants)
    .innerJoin(members, eq(participants.memberId, members.id)).where(and(
      eq(participants.conversationId, id), isNull(participants.deletedAt), isNull(members.deletedAt),
      eq(members.householdId, conversation.householdId),
    )).orderBy(asc(participants.memberId)).all().map((row) => row.id);
  const owner = conversation.ownerMemberId ? db.select().from(members).where(and(
    eq(members.id, conversation.ownerMemberId), isNull(members.deletedAt),
  )).get() : undefined;
  const resource = { ...conversation, participantMemberIds };
  if (!canSeeConversation(actor, resource) || (conversation.kind === "direct"
    && (!owner || owner.householdId !== conversation.householdId))) {
    throw new ConversationNotFoundError();
  }
  return { ...resource, publisherHostId: owner?.homeHostId ?? conversation.publisherHostId };
}

function conversationDto(db: Reader, row: ReturnType<typeof visible>): Conversation {
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
  return db.transaction((tx) => conversationDto(tx, visible(tx, actor, id)));
}

export function listConversations(db: Pick<StoreDb, "transaction">, actor: Actor): Conversation[] {
  return db.transaction((tx) => {
    const rows = tx.select().from(conversations).where(and(
      eq(conversations.householdId, actor.householdId), isNull(conversations.deletedAt),
      or(eq(conversations.kind, "group"), eq(conversations.ownerMemberId, actor.memberId)),
    )).all();
    const result: Conversation[] = [];
    for (const row of rows) {
      try {
        result.push(conversationDto(tx, visible(tx, actor, row.id)));
      } catch (error) {
        if (!(error instanceof ConversationNotFoundError)) {
          throw error;
        }
      }
    }
    return result.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "group" ? -1 : 1));
  });
}

export function readMessages(
  db: Pick<StoreDb, "transaction">, actor: Actor, conversationId: string,
  input: { before?: string; after?: string; limit?: number } = {},
): MessagePage {
  return db.transaction((tx) => {
    visible(tx, actor, conversationId);
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

export function sendMessage(
  db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor, conversationId: string,
  input: { clientMessageId: string; text: string },
) {
  const text = input.text.trim();
  if (input.clientMessageId.length < 1 || input.clientMessageId.length > 100 || text.length < 1 || text.length > 4000) {
    throw new InvalidChatRequestError("消息格式无效");
  }
  return db.transaction((tx) => {
    const conversation = visible(tx, actor, conversationId);
    const hostId = getHostMeta(tx, "host_id");
    if (!hostId || conversation.publisherHostId !== hostId) {
      throw new NotPublisherError();
    }
    const existing = tx.select().from(messages).where(and(
      eq(messages.conversationId, conversationId), eq(messages.authorMemberId, actor.memberId),
      eq(messages.clientMessageId, input.clientMessageId),
    )).get();
    if (existing) {
      if (existing.text !== text) {
        throw new IdempotencyConflictError();
      }
      return { created: false, body: { message: dto(existing), turn: null } };
    }
    const row = tx.insert(messages).values({
      ...businessRow(clock, hostId), conversationId, authorMemberId: actor.memberId, text, modality: "text",
      status: "complete", clientMessageId: input.clientMessageId, replyToMessageId: null, turnId: null,
    }).returning().get()!;
    tx.update(conversations).set({ ...revision(clock), rev: sql`${conversations.rev} + 1` })
      .where(eq(conversations.id, conversationId)).run();
    return { created: true, body: { message: dto(row), turn: null } };
  }, { behavior: "immediate" });
}
