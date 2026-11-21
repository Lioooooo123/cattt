import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { validateWallMs } from "../clock/hlc.ts";
import { writeTransaction } from "./index.ts";
import type { Store, StoreDb } from "./index.ts";
import { chatEvents } from "./schema/index.ts";

export const TERMINAL_RETENTION_MS = 10 * 60 * 1000;
export const ACTIVE_RETENTION_MS = 60 * 60 * 1000;
export type ChatEvent = Omit<typeof chatEvents.$inferSelect, "data"> & { data: unknown };
export interface AppendChatEvent {
  streamId: string;
  kind: string;
  data: unknown;
  terminal?: boolean;
  seqFloor?: number;
}

export class ChatStreamClosedError extends Error {
  constructor(public readonly streamId: string) {
    super(`事件流已经结束：${streamId}`);
    this.name = "ChatStreamClosedError";
  }
}

function wallMs(clock: Clock): number {
  const now = clock.wallMs();
  validateWallMs(now);
  return now;
}

export function getChatStream(db: Pick<StoreDb, "select">, clock: Clock, streamId: string) {
  const now = wallMs(clock);
  const row = db.select({
    seq: max(chatEvents.seq),
    createdAt: max(chatEvents.createdAt),
    terminal: sql<number>`max(${chatEvents.terminal})`,
  }).from(chatEvents).where(eq(chatEvents.streamId, streamId)).get();
  if (!row || row.seq === null || row.createdAt === null) {
    return undefined;
  }
  const terminal = row.terminal === 1;
  if (row.createdAt <= now - (terminal ? TERMINAL_RETENTION_MS : ACTIVE_RETENTION_MS)) {
    return undefined;
  }
  return { seq: row.seq, terminal, createdAt: row.createdAt };
}

export function appendChatEvent(db: Pick<StoreDb, "transaction">, clock: Clock, input: AppendChatEvent): number {
  if (!input.streamId || !input.kind || /[\r\n\0]/.test(input.kind)) {
    throw new TypeError("事件流和事件类型不能为空，事件类型不能包含换行或空字符");
  }
  const encoded = JSON.stringify(input.data);
  if (encoded === undefined) {
    throw new TypeError("事件数据必须可序列化为 JSON");
  }
  return db.transaction((tx) => {
    const last = tx.select({ seq: chatEvents.seq, terminal: chatEvents.terminal })
      .from(chatEvents).where(eq(chatEvents.streamId, input.streamId))
      .orderBy(sql`${chatEvents.seq} DESC`).get();
    if (last?.terminal) {
      throw new ChatStreamClosedError(input.streamId);
    }
    if (input.seqFloor !== undefined && (!Number.isSafeInteger(input.seqFloor) || input.seqFloor < 0)) {
      throw new RangeError("事件序号水位须为非负安全整数");
    }
    const seq = Math.max(last?.seq ?? 0, input.seqFloor ?? 0) + 1;
    if (!Number.isSafeInteger(seq)) {
      throw new RangeError("事件序号超出范围");
    }
    tx.insert(chatEvents).values({
      streamId: input.streamId,
      seq,
      kind: input.kind,
      data: encoded,
      terminal: input.terminal ?? false,
      createdAt: wallMs(clock),
    }).run();
    return seq;
  }, { behavior: "immediate" });
}

export function readChatEvents(
  db: Pick<StoreDb, "select">,
  clock: Clock,
  streamId: string,
  afterSeq = 0,
  limit = 100,
): ChatEvent[] {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0
    || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("读取位置须为非负整数，批量大小须为正整数");
  }
  if (!getChatStream(db, clock, streamId)) {
    return [];
  }
  return db.select().from(chatEvents).where(and(
    eq(chatEvents.streamId, streamId), gt(chatEvents.seq, afterSeq),
  )).orderBy(asc(chatEvents.seq)).limit(limit).all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
}

export function sweepChatEvents(db: StoreDb, clock: Clock): number {
  return db.transaction((tx) => {
    const now = wallMs(clock);
    const expired = tx.select({ streamId: chatEvents.streamId }).from(chatEvents)
      .groupBy(chatEvents.streamId).having(sql`max(${chatEvents.createdAt}) <= ${now} -
        CASE WHEN max(${chatEvents.terminal}) = 1
        THEN ${TERMINAL_RETENTION_MS} ELSE ${ACTIVE_RETENTION_MS} END`);
    return tx.delete(chatEvents).where(inArray(chatEvents.streamId, expired))
      .returning({ seq: chatEvents.seq }).all().length;
  }, { behavior: "immediate" });
}

export function writeChatEvents<T>(
  store: Store,
  clock: Clock,
  write: (db: StoreDb, append: (input: AppendChatEvent) => number) => T,
): { result: T; wakes: { streamId: string; seq: number }[] } {
  if (store.raw.inTransaction) {
    throw new Error("提交后唤醒必须由最外层事件写事务负责");
  }
  const wakes: { streamId: string; seq: number }[] = [];
  const result = writeTransaction(store, (db) => write(db, (input) => {
    const seq = appendChatEvent(db, clock, input);
    wakes.push({ streamId: input.streamId, seq });
    return seq;
  }));
  return { result, wakes };
}
