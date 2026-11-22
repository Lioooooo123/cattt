import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Turn } from "../conversations/types.ts";
import { uuidv7 } from "../ids/index.ts";
import { appendChatEvent } from "./chat-events.ts";
import type { AppendChatEvent } from "./chat-events.ts";
import type { StoreDb } from "./index.ts";
import { turns } from "./schema/turns.ts";

export type TurnRow = typeof turns.$inferSelect;
export type TurnDb = Pick<StoreDb, "select" | "insert" | "update" | "transaction">;
export type Append = (event: AppendChatEvent) => number;

export function turnDto(row: TurnRow): Turn {
  return {
    id: row.id, conversation_id: row.conversationId, status: row.status,
    trigger_message_id: row.triggerMessageId, reply_message_id: row.replyMessageId, error_code: row.errorCode,
    stream_url: `/v2/conversations/${row.conversationId}/turns/${row.id}/stream`,
  };
}

export function initialTurn(row: TurnRow): Turn {
  return { ...turnDto(row), status: "queued", reply_message_id: null, error_code: null };
}

export function active(row: TurnRow): boolean {
  return row.status === "queued" || row.status === "generating";
}

export function turnEvent(db: TurnDb, clock: Clock, id: string, event: Omit<AppendChatEvent, "streamId">, append?: Append) {
  const row = db.select().from(turns).where(eq(turns.id, id)).get()!;
  const input = { ...event, streamId: id, seqFloor: row.eventSeq };
  const seq = append ? append(input) : appendChatEvent(db, clock, input);
  db.update(turns).set({ eventSeq: seq }).where(eq(turns.id, id)).run();
}

export function createTurn(db: TurnDb, clock: Clock, conversationId: string, triggerMessageId: string, requestId: string | null, append?: Append, publicationEpoch?: string) {
  const now = clock.wallMs();
  const row = db.insert(turns).values({
    id: uuidv7(clock), conversationId, triggerMessageId, requestId, status: "queued", replyMessageId: null,
    errorCode: null, cancelReason: null, visibleLength: null, firstTokenAt: null, heartbeatAt: now,
    publicationEpoch: publicationEpoch ?? null, createdAt: now, finishedAt: null, draftText: "", eventSeq: 0, supersededByTurnId: null,
  }).returning().get()!;
  const pending = db.select().from(turns).where(and(
    eq(turns.conversationId, conversationId), inArray(turns.status, ["queued", "generating"]), isNull(turns.firstTokenAt),
  )).all();
  for (const previous of pending) {
    if (previous.id === row.id) {
      continue;
    }
    db.update(turns).set({ status: "superseded", cancelReason: "supersede", finishedAt: now, supersededByTurnId: row.id })
      .where(eq(turns.id, previous.id)).run();
    turnEvent(db, clock, previous.id, { kind: "superseded", data: { turn_id: previous.id, by_turn_id: row.id }, terminal: true }, append);
  }
  turnEvent(db, clock, row.id, { kind: "accepted", data: { turn_id: row.id, trigger_message_id: triggerMessageId } }, append);
  return row;
}
