import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents } from "../src/chat-events/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { TERMINAL_RETENTION_MS } from "../src/store/chat-events.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { testTurn } from "./turn-fixture.ts";
import { sweepChatEvents } from "../src/store/chat-events.ts";
import { turns } from "../src/store/schema/turns.ts";

function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    cancel: () => reader.cancel(),
    async next(): Promise<string | undefined> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return frame;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          return undefined;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

test("轮次 SSE 实时送达、断线补齐、终态排空与过期快照", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-sse-"));
  const gateway = new Gateway();
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0, clock }, [gateway]);
  const { token } = issueTestDevice(host);
  const authorization = { Authorization: `Bearer ${token}` };
  const events = new ChatEvents(host);
  const turn = testTurn(host, token);
  const url = `http://127.0.0.1:${gateway.port}${turn.turn.stream_url}`;
  const clients: ReturnType<typeof frames>[] = [];
  let subscriptions = 0;
  const original = host.bus.subscribe.bind(host.bus);
  host.bus.subscribe = (topic, handler) => {
    if (topic === "chat:event") {
      subscriptions += 1;
    }
    const remove = original(topic, handler);
    return () => {
      if (topic === "chat:event") {
        subscriptions -= 1;
      }
      remove();
    };
  };
  const open = async (suffix = "", headers?: Record<string, string>) => {
    const response = await fetch(url + suffix, {
      headers: { ...authorization, ...headers }, signal: AbortSignal.timeout(4000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const client = frames(response);
    clients.push(client);
    expect(await client.next()).toBe(": connected");
    return client;
  };
  try {
    const first = await open();
    expect(await first.next()).toBe(`id: ${events.cursor(1)}\nevent: accepted\ndata: ${JSON.stringify({ turn_id: turn.turn.id, trigger_message_id: turn.turn.trigger_message_id })}`);
    turn.delta("头");
    expect(await first.next()).toBe(`id: ${events.cursor(2)}\nevent: delta\ndata: {"text":"头"}`);
    await first.cancel();
    for (let i = 0; i < 100 && subscriptions !== 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(subscriptions).toBe(0);
    turn.delta("中");
    turn.delta("尾\n字");
    const resumed = await open("?last_event_id=garbage", { "Last-Event-ID": events.cursor(2) });
    expect(await resumed.next()).toBe(`id: ${events.cursor(3)}\nevent: delta\ndata: {"text":"中"}`);
    expect(await resumed.next()).toBe(`id: ${events.cursor(4)}\nevent: delta\ndata: {"text":"尾\\n字"}`);
    const final = turn.done();
    expect(await resumed.next()).toBe(`id: ${events.cursor(5)}\nevent: done\ndata: ${JSON.stringify({ message_id: final.reply_message_id, status: "completed" })}`);
    expect(await resumed.next()).toBeUndefined();
    expect(subscriptions).toBe(0);
    const queryResume = await open(`?last_event_id=${events.cursor(4)}`);
    expect(await queryResume.next()).toContain(`id: ${events.cursor(5)}\nevent: done`);
    expect(await queryResume.next()).toBeUndefined();
    const ended = await open("", { "Last-Event-ID": events.cursor(5) });
    expect(await ended.next()).toContain('event: snapshot\ndata: {"text":"头中尾\\n字"}');
    expect(await ended.next()).toContain("event: done");
    expect(await ended.next()).toBeUndefined();
    for (const cursor of ["foreign.1", "garbage", events.cursor(6), `${host.hostId}.01`]) {
      const recovered = await open("", { "Last-Event-ID": cursor });
      expect(await recovered.next()).toContain("event: snapshot");
      expect(await recovered.next()).toContain("event: done");
      expect(await recovered.next()).toBeUndefined();
    }
    clock.advance(TERMINAL_RETENTION_MS);
    sweepChatEvents(host.store.db, clock);
    host.store.db.update(turns).set({ draftText: "" }).where(eq(turns.id, turn.turn.id)).run();
    const expired = await open(`?last_event_id=${events.cursor(4)}`);
    expect(await expired.next()).toContain('event: snapshot\ndata: {"text":"头中尾\\n字"}');
    expect(await expired.next()).toContain("event: done");
    expect(await expired.next()).toBeUndefined();
    const missing = await fetch(url.replace(turn.turn.id, turn.turn.conversation_id), { headers: authorization });
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  } finally {
    for (const client of clients) {
      await client.cancel().catch(() => {});
    }
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("空闲 SSE 按配置发送心跳，宿主停止中断等待后再关闭数据库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-sse-stop-"));
  const gateway = new Gateway({ heartbeatIntervalMs: 10 });
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0 }, [gateway]);
  try {
    const { token } = issueTestDevice(host);
    const events = new ChatEvents(host);
    const turn = testTurn(host, token);
    const response = await fetch(`http://127.0.0.1:${gateway.port}${turn.turn.stream_url}`, {
      headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": events.cursor(1) },
    });
    const client = frames(response);
    expect(await client.next()).toBe(": connected");
    expect(await client.next()).toBe(": heartbeat");
    const pending = client.next().catch(() => undefined);
    await host.stop();
    expect(await pending).toBeUndefined();
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Gateway 拒绝无效心跳间隔", () => {
  for (const heartbeatIntervalMs of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => new Gateway({ heartbeatIntervalMs })).toThrow(RangeError);
  }
});
