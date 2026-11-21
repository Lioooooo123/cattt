import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents, ChatEventSweeper } from "../src/chat-events/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { appendChatEvent, readChatEvents, TERMINAL_RETENTION_MS } from "../src/store/chat-events.ts";
import { getHostMeta, setHostMeta } from "../src/store/host-meta.ts";
import { writeTransaction } from "../src/store/index.ts";

const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
const directories: string[] = [];

async function setup(sweeper?: ChatEventSweeper) {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-events-"));
  directories.push(dataDir);
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir, clock }, sweeper ? [sweeper] : []);
  hosts.push(host);
  return { host, clock, events: new ChatEvents(host) };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("提交后才唤醒，事务回滚和嵌套误用均不发布通知", async () => {
  const { host, events, clock } = await setup();
  const wakes: number[] = [];
  host.bus.subscribe("chat:event", ({ streamId, seq }) => {
    expect(readChatEvents(host.store.db, clock, streamId, seq - 1, 1)[0]!.seq).toBe(seq);
    expect(host.store.raw.inTransaction).toBe(false);
    expect(getHostMeta(host.store.db, "atomic")).toBe("已提交");
    wakes.push(seq);
  });
  expect(() => events.write((db, append) => {
    setHostMeta(db, "atomic", "应回滚");
    append({ streamId: "a", kind: "delta", data: 1 });
    expect(wakes).toEqual([]);
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(wakes).toEqual([]);
  expect(readChatEvents(host.store.db, clock, "a")).toEqual([]);
  expect(getHostMeta(host.store.db, "atomic")).toBeUndefined();
  events.write((db, append) => {
    setHostMeta(db, "atomic", "已提交");
    append({ streamId: "a", kind: "delta", data: 1 });
    append({ streamId: "a", kind: "delta", data: 2 });
    expect(wakes).toEqual([]);
  });
  expect(wakes).toEqual([1, 2]);
  expect(() => writeTransaction(host.store, () => {
    events.append({ streamId: "a", kind: "delta", data: 3 });
  })).toThrow("最外层");
  expect(wakes).toEqual([1, 2]);
});

test("从游标回放后等待实时唤醒，终态前完整排空跨批尾部", async () => {
  const { events } = await setup();
  events.append({ streamId: "a", kind: "delta", data: 1 });
  const subscription = events.subscribe("a", events.cursor(1));
  if (subscription.status !== "ok") {
    throw new Error("缺少订阅");
  }
  const next = subscription.events.next();
  events.append({ streamId: "a", kind: "delta", data: 2 });
  expect((await next).value).toMatchObject({ seq: 2, cursor: events.cursor(2) });
  events.write((_db, append) => {
    for (let i = 3; i <= 205; i += 1) {
      append({ streamId: "a", kind: "delta", data: i });
    }
    append({ streamId: "a", kind: "done", data: null, terminal: true });
  });
  const sequences: number[] = [];
  for await (const event of subscription.events) {
    sequences.push(event.seq);
  }
  expect(sequences).toEqual(Array.from({ length: 204 }, (_, i) => i + 3));
  const ended = events.subscribe("a", events.cursor(206));
  if (ended.status !== "ok") {
    throw new Error("终态游标应有效");
  }
  expect(await ended.events.next()).toEqual({ done: true, value: "end" });
});

test("异宿主、坏格式、越界、缺失与过期游标返回 unknown", async () => {
  const { events, clock, host } = await setup();
  events.append({ streamId: "a", kind: "done", data: {}, terminal: true });
  for (const cursor of [
    "foreign.1", "garbage", "", events.cursor(2), "pg-1", "0",
    `${host.hostId}.9007199254740992`,
  ]) {
    expect(events.subscribe("a", cursor).status).toBe("unknown");
  }
  expect(events.subscribe("missing").status).toBe("unknown");
  clock.advance(TERMINAL_RETENTION_MS);
  expect(events.subscribe("a", events.cursor(1)).status).toBe("unknown");
  expect(events.subscribe("a").status).toBe("unknown");
});

test("丢失总线通知由一秒轮询补齐，AbortSignal 唤醒并移除订阅", async () => {
  const { host, clock, events } = await setup();
  events.append({ streamId: "a", kind: "delta", data: 1 });
  const abort = new AbortController();
  let subscriptions = 0;
  const original = host.bus.subscribe.bind(host.bus);
  host.bus.subscribe = (topic, handler) => {
    subscriptions += 1;
    const remove = original(topic, handler);
    return () => {
      subscriptions -= 1;
      remove();
    };
  };
  const subscription = events.subscribe("a", events.cursor(1), abort.signal);
  if (subscription.status !== "ok") {
    throw new Error("缺少订阅");
  }
  const next = subscription.events.next();
  expect(subscriptions).toBe(1);
  appendChatEvent(host.store.db, clock, { streamId: "a", kind: "delta", data: 2 });
  expect((await next).value).toMatchObject({ seq: 2 });
  const pending = subscription.events.next();
  abort.abort();
  expect(await pending).toEqual({ done: true, value: "aborted" });
  expect(subscriptions).toBe(0);
}, 3000);

test("周期清扫使用 Clock，停止后不再清扫", async () => {
  const sweeper = new ChatEventSweeper(5);
  const { host, clock, events } = await setup(sweeper);
  events.append({ streamId: "a", kind: "done", data: {}, terminal: true });
  clock.advance(TERMINAL_RETENTION_MS);
  for (let i = 0; i < 100; i += 1) {
    const count = host.store.raw.query<{ count: number }, []>("SELECT count(*) AS count FROM chat_events").get()!.count;
    if (count === 0) {
      break;
    }
    await Bun.sleep(5);
  }
  expect(host.store.raw.query("SELECT count(*) AS count FROM chat_events").get()).toEqual({ count: 0 });
  sweeper.stop();
  events.append({ streamId: "b", kind: "done", data: {}, terminal: true });
  clock.advance(TERMINAL_RETENTION_MS);
  await Bun.sleep(20);
  expect(host.store.raw.query("SELECT count(*) AS count FROM chat_events").get()).toEqual({ count: 1 });
  expect(() => new ChatEventSweeper(0)).toThrow();
});
