import { and, asc, eq, inArray, isNull, lte, min } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow, revision } from "./business.ts";
import { getChatStream, readChatEvents } from "./chat-events.ts";
import { ConversationNotFoundError, getConversation, IdempotencyConflictError, messageDto, NotPublisherError, readMessages } from "./conversations.ts";
import { getHostMeta } from "./host-meta.ts";
import type { StoreDb } from "./index.ts";
import { assertLeaseHeld } from "./leases.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { members } from "./schema/identity.ts";
import { turns } from "./schema/turns.ts";
import { chatEvents as chatEventTable } from "./schema/index.ts";
import { active, createTurn, turnDto, turnEvent } from "./turn-writes.ts";
import type { Append, TurnDb, TurnRow } from "./turn-writes.ts";

export interface TurnFence { name: string; holder: string; epoch: number }

export function getTurnRow(db: Pick<StoreDb, "select">, id: string) {
  return db.select().from(turns).where(eq(turns.id, id)).get();
}

export function getTurn(db: Pick<StoreDb, "transaction">, actor: Actor, conversationId: string, id: string) {
  return db.transaction((tx) => {
    getConversation(tx, actor, conversationId);
    const row = getTurnRow(tx, id);
    if (!row || row.conversationId !== conversationId) {
      throw new ConversationNotFoundError();
    }
    return turnDto(row);
  });
}

function publisher(db: TurnDb, actor: Actor, conversationId: string) {
  const conversation = getConversation(db, actor, conversationId);
  if (conversation.publisher_host_id !== getHostMeta(db, "host_id")) {
    throw new NotPublisherError();
  }
}

export function retryTurn(db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor, conversationId: string, messageId: string, requestId: string, append?: Append) {
  return db.transaction((tx) => {
    publisher(tx, actor, conversationId);
    const message = tx.select().from(messages).where(and(
      eq(messages.id, messageId), eq(messages.conversationId, conversationId), isNull(messages.deletedAt),
    )).get();
    if (!message || message.authorMemberId === null) {
      throw new ConversationNotFoundError();
    }
    const existing = tx.select().from(turns).where(eq(turns.requestId, requestId)).get();
    if (existing) {
      if (existing.conversationId !== conversationId || existing.triggerMessageId !== messageId) {
        throw new IdempotencyConflictError();
      }
      return { created: false, turn: turnDto(existing) };
    }
    return { created: true, turn: turnDto(createTurn(tx, clock, conversationId, messageId, requestId, append)) };
  }, { behavior: "immediate" });
}

export function cancelTurn(db: Pick<StoreDb, "transaction">, clock: Clock, actor: Actor, conversationId: string, id: string, visibleLength?: number, append?: Append) {
  return db.transaction((tx) => {
    getTurn(tx, actor, conversationId, id);
    publisher(tx, actor, conversationId);
    const row = getTurnRow(tx, id)!;
    if (active(row) && row.cancelReason === null) {
      tx.update(turns).set({ cancelReason: "stop", visibleLength: visibleLength ?? null }).where(eq(turns.id, id)).run();
      if (row.status === "queued") {
        finishTurn(tx, clock, id, { status: "stopped" }, append);
      }
    }
    return turnDto(getTurnRow(tx, id)!);
  }, { behavior: "immediate" });
}

function fenceHeld(db: Pick<StoreDb, "select">, clock: Clock, fence: TurnFence) {
  assertLeaseHeld(db, clock, fence.name, fence.holder, fence.epoch);
}

export function claimTurn(db: Pick<StoreDb, "transaction">, clock: Clock, id: string, fence: TurnFence): boolean {
  return db.transaction((tx) => {
    fenceHeld(tx, clock, fence);
    const row = getTurnRow(tx, id);
    if (!row || row.status !== "queued") {
      return false;
    }
    tx.update(turns).set({ status: "generating", heartbeatAt: clock.wallMs() }).where(eq(turns.id, id)).run();
    return true;
  }, { behavior: "immediate" });
}

export function heartbeatTurn(db: Pick<StoreDb, "transaction">, clock: Clock, id: string, fence: TurnFence): boolean {
  return db.transaction((tx) => {
    fenceHeld(tx, clock, fence);
    const row = getTurnRow(tx, id);
    if (!row || row.status !== "generating" || row.cancelReason !== null) {
      return false;
    }
    tx.update(turns).set({ heartbeatAt: clock.wallMs() }).where(eq(turns.id, id)).run();
    return true;
  }, { behavior: "immediate" });
}

export function appendDelta(db: Pick<StoreDb, "transaction">, clock: Clock, id: string, text: string, fence: TurnFence, append?: Append): boolean {
  return db.transaction((tx) => {
    fenceHeld(tx, clock, fence);
    const row = getTurnRow(tx, id);
    if (!row || row.status !== "generating" || row.cancelReason !== null) {
      return false;
    }
    if (text.length) {
      tx.update(turns).set({ draftText: row.draftText + text, firstTokenAt: row.firstTokenAt ?? clock.wallMs(), heartbeatAt: clock.wallMs() })
        .where(eq(turns.id, id)).run();
      turnEvent(tx, clock, id, { kind: "delta", data: { text } }, append);
    }
    return true;
  }, { behavior: "immediate" });
}

function visiblePrefix(text: string, length: number | null): string {
  let end = Math.min(text.length, length ?? text.length);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function terminalEvent(row: TurnRow) {
  if (row.status === "superseded") {
    return { kind: "superseded", data: { turn_id: row.id, by_turn_id: row.supersededByTurnId } };
  }
  if (row.status === "failed") {
    return { kind: "error", data: { code: row.errorCode, retryable: row.errorCode !== "conversation_unavailable" } };
  }
  return { kind: "done", data: { message_id: row.replyMessageId, status: row.status } };
}

export function finishTurn(
  db: Pick<StoreDb, "transaction">, clock: Clock, id: string,
  outcome: { status: "completed" | "stopped" | "failed"; errorCode?: string; fence?: TurnFence }, append?: Append,
) {
  return db.transaction((tx) => {
    if (outcome.fence) {
      fenceHeld(tx, clock, outcome.fence);
    }
    const row = getTurnRow(tx, id)!;
    if (!active(row)) {
      return turnDto(row);
    }
    const status = row.cancelReason === "stop" && outcome.fence && outcome.errorCode !== "conversation_unavailable" ? "stopped" : outcome.status;
    const text = status === "stopped" ? visiblePrefix(row.draftText, row.visibleLength) : row.draftText;
    let replyMessageId: string | null = null;
    if (status !== "failed" && text.length) {
      if (!outcome.fence) {
        throw new Error("回复发布必须携带租约 fencing token");
      }
      const input = turnInput(tx, id, 1);
      if (input.conversation.publisher_host_id !== getHostMeta(tx, "host_id")) {
        throw new NotPublisherError();
      }
      const message = tx.insert(messages).values({
        ...businessRow(clock, getHostMeta(tx, "host_id")!), conversationId: row.conversationId, authorMemberId: null,
        text, modality: "text", status: status === "stopped" ? "stopped" : "complete", clientMessageId: null,
        replyToMessageId: row.triggerMessageId, turnId: row.id,
      }).returning().get()!;
      replyMessageId = message.id;
      const conversation = tx.select().from(conversations).where(eq(conversations.id, row.conversationId)).get()!;
      tx.update(conversations).set({ ...revision(clock), rev: conversation.rev + 1 }).where(eq(conversations.id, row.conversationId)).run();
    }
    tx.update(turns).set({
      status, replyMessageId, errorCode: status === "failed" ? outcome.errorCode ?? "replier_error" : null,
      draftText: text, finishedAt: clock.wallMs(),
    }).where(eq(turns.id, id)).run();
    turnEvent(tx, clock, id, { ...terminalEvent(getTurnRow(tx, id)!), terminal: true }, append);
    return turnDto(getTurnRow(tx, id)!);
  }, { behavior: "immediate" });
}

export function turnInput(db: TurnDb, id: string, limit: number) {
  const row = getTurnRow(db, id)!;
  const trigger = db.select().from(messages).where(and(eq(messages.id, row.triggerMessageId), isNull(messages.deletedAt))).get();
  const conversation = db.select().from(conversations).where(eq(conversations.id, row.conversationId)).get();
  if (!trigger || !trigger.authorMemberId || !conversation) {
    throw new ConversationNotFoundError();
  }
  const member = db.select().from(members).where(eq(members.id, trigger.authorMemberId)).get();
  if (!member || member.deletedAt !== null) {
    throw new ConversationNotFoundError();
  }
  const actor = { memberId: member.id, householdId: member.householdId, hostId: getHostMeta(db, "host_id")!, deviceId: "runner" };
  return {
    conversation: getConversation(db, actor, row.conversationId),
    history: readMessages(db, actor, row.conversationId, { limit }).messages,
    trigger: messageDto(trigger),
  };
}

export function queuedTurns(db: Pick<StoreDb, "select">) {
  return db.select().from(turns).where(eq(turns.status, "queued")).orderBy(asc(turns.createdAt), asc(turns.id)).all();
}

export function recoverTurns(db: Pick<StoreDb, "transaction">, clock: Clock, staleMs: number, includeQueued: boolean, append?: Append) {
  db.transaction((tx) => {
    const rows = tx.select().from(turns).where(and(
      inArray(turns.status, includeQueued ? ["queued", "generating"] : ["generating"]), lte(turns.heartbeatAt, clock.wallMs() - staleMs),
    )).all();
    for (const row of rows) {
      finishTurn(tx, clock, row.id, { status: "failed", errorCode: "interrupted" }, append);
    }
  }, { behavior: "immediate" });
}

export function readTurnFeed(db: Pick<StoreDb, "transaction">, clock: Clock, id: string, afterSeq: number) {
  return db.transaction((tx) => {
    const row = getTurnRow(tx, id)!;
    const stream = getChatStream(tx, clock, id);
    const first = tx.select({ seq: min(chatEventTable.seq) }).from(chatEventTable).where(eq(chatEventTable.streamId, id)).get()?.seq;
    const reply = row.replyMessageId ? tx.select().from(messages).where(eq(messages.id, row.replyMessageId)).get() : undefined;
    return {
      row, text: reply?.text ?? row.draftText,
      replayable: !!stream && first !== null && first !== undefined && afterSeq >= first - 1 && afterSeq <= stream.seq,
      events: readChatEvents(tx, clock, id, afterSeq, 100),
    };
  });
}
