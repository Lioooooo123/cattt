import { afterEach, expect, test } from "bun:test";
import { ManualClock } from "../src/clock/index.ts";
import {
  ACTIVE_RETENTION_MS,
  appendChatEvent,
  ChatStreamClosedError,
  getChatStream,
  readChatEvents,
  sweepChatEvents,
  TERMINAL_RETENTION_MS,
} from "../src/store/chat-events.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  return { store, db: store.db, clock: new ManualClock("test", 100) };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("事件按流递增序号，JSON 往返，游标和批量限制按序读取", () => {
  const { db, clock } = setup();
  expect(readChatEvents(db, clock, "missing", 0, 10)).toEqual([]);
  expect(appendChatEvent(db, clock, { streamId: "a", kind: "delta", data: { text: "猫\n猫" } })).toBe(1);
  clock.advance(5);
  expect(appendChatEvent(db, clock, { streamId: "b", kind: "delta", data: null })).toBe(1);
  expect(appendChatEvent(db, clock, { streamId: "a", kind: "delta", data: ["尾字"] })).toBe(2);
  expect(appendChatEvent(db, clock, { streamId: "a", kind: "done", data: {}, terminal: true })).toBe(3);
  expect(readChatEvents(db, clock, "a", 0, 1)).toEqual([{
    streamId: "a", seq: 1, kind: "delta", data: { text: "猫\n猫" }, terminal: false, createdAt: 100,
  }]);
  expect(readChatEvents(db, clock, "a", 1, 10).map((row) => row.seq)).toEqual([2, 3]);
  expect(readChatEvents(db, clock, "b", 0, 10)[0]!.data).toBeNull();
  expect(() => appendChatEvent(db, clock, { streamId: "a", kind: "delta", data: "迟到" }))
    .toThrow(ChatStreamClosedError);
});

test("调用方立即事务可以原子追加多个事件，异常全部回滚且不消耗序号", () => {
  const { db, store, clock } = setup();
  expect(() => writeTransaction(store, (tx) => {
    appendChatEvent(tx, clock, { streamId: "a", kind: "delta", data: 1 });
    appendChatEvent(tx, clock, { streamId: "a", kind: "done", data: 2, terminal: true });
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(getChatStream(db, clock, "a")).toBeUndefined();
  expect(appendChatEvent(db, clock, { streamId: "a", kind: "delta", data: 3 })).toBe(1);
});

test("保留窗口从最后事件算起，终态十分钟和非终态一小时，读取和清扫一致", () => {
  const { db, clock } = setup();
  appendChatEvent(db, clock, { streamId: "done", kind: "delta", data: 1 });
  appendChatEvent(db, clock, { streamId: "active", kind: "delta", data: 1 });
  clock.advance(100);
  appendChatEvent(db, clock, { streamId: "done", kind: "done", data: 2, terminal: true });
  appendChatEvent(db, clock, { streamId: "active", kind: "delta", data: 2 });
  clock.setWallMs(200 + TERMINAL_RETENTION_MS - 1);
  expect(readChatEvents(db, clock, "done", 0, 10).length).toBe(2);
  clock.advance(1);
  expect(readChatEvents(db, clock, "done", 0, 10)).toEqual([]);
  expect(readChatEvents(db, clock, "active", 0, 10).length).toBe(2);
  expect(sweepChatEvents(db, clock)).toBe(2);
  clock.setWallMs(200 + ACTIVE_RETENTION_MS - 1);
  expect(sweepChatEvents(db, clock)).toBe(0);
  expect(readChatEvents(db, clock, "active", 0, 10).length).toBe(2);
  clock.advance(1);
  expect(readChatEvents(db, clock, "active", 0, 10)).toEqual([]);
  expect(sweepChatEvents(db, clock)).toBe(2);
  expect(sweepChatEvents(db, clock)).toBe(0);
});

test("非法事件或分页参数不产生记录", () => {
  const { db, clock } = setup();
  for (const input of [
    { streamId: "", kind: "delta", data: 1 },
    { streamId: "a", kind: "", data: 1 },
    { streamId: "a", kind: "delta\nevent: done", data: 1 },
    { streamId: "a", kind: "delta", data: undefined },
    { streamId: "a", kind: "delta", data: 1n },
  ]) {
    expect(() => appendChatEvent(db, clock, input)).toThrow();
  }
  expect(getChatStream(db, clock, "a")).toBeUndefined();
  expect(() => readChatEvents(db, clock, "a", -1, 10)).toThrow();
  expect(() => readChatEvents(db, clock, "a", 0, 0)).toThrow();
});
