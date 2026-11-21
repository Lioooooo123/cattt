import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents } from "../src/chat-events/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { TERMINAL_RETENTION_MS } from "../src/store/chat-events.ts";

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

test("真实 SSE 实时送达、断线补齐、终态排空关闭和坏游标 410", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-sse-"));
  const gateway = new Gateway();
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir: directory, port: 0, clock }, [gateway]);
  const events = new ChatEvents(host);
  const url = `http://127.0.0.1:${gateway.port}/v2/streams/turn/events`;
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
    const response = await fetch(url + suffix, { headers, signal: AbortSignal.timeout(4000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const client = frames(response);
    clients.push(client);
    expect(await client.next()).toBe(": connected");
    return client;
  };
  try {
    events.append({ streamId: "turn", kind: "accepted", data: { turnId: "turn" } });
    const first = await open();
    expect(await first.next()).toBe(`id: ${events.cursor(1)}\nevent: accepted\ndata: {"turnId":"turn"}`);
    events.append({ streamId: "turn", kind: "delta", data: { text: "头" } });
    expect(await first.next()).toBe(`id: ${events.cursor(2)}\nevent: delta\ndata: {"text":"头"}`);
    await first.cancel();
    for (let i = 0; i < 100 && subscriptions !== 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(subscriptions).toBe(0);
    events.append({ streamId: "turn", kind: "delta", data: { text: "中" } });
    events.append({ streamId: "turn", kind: "delta", data: { text: "尾\n字" } });
    const resumed = await open("?cursor=garbage", { "Last-Event-ID": events.cursor(2) });
    expect(await resumed.next()).toBe(`id: ${events.cursor(3)}\nevent: delta\ndata: {"text":"中"}`);
    expect(await resumed.next()).toBe(`id: ${events.cursor(4)}\nevent: delta\ndata: {"text":"尾\\n字"}`);
    events.append({ streamId: "turn", kind: "done", data: { ok: true }, terminal: true });
    expect(await resumed.next()).toBe(`id: ${events.cursor(5)}\nevent: done\ndata: {"ok":true}`);
    expect(await resumed.next()).toBeUndefined();
    expect(subscriptions).toBe(0);
    const queryResume = await open(`?cursor=${events.cursor(4)}`);
    expect(await queryResume.next()).toContain(`id: ${events.cursor(5)}\nevent: done`);
    expect(await queryResume.next()).toBeUndefined();
    const ended = await open("", { "Last-Event-ID": events.cursor(5) });
    expect(await ended.next()).toBeUndefined();
    for (const cursor of ["foreign.1", "garbage", events.cursor(6), `${host.hostId}.01`]) {
      const response = await fetch(url, { headers: { "Last-Event-ID": cursor } });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ reason: "cursor_unknown" });
    }
    clock.advance(TERMINAL_RETENTION_MS);
    const expired = await fetch(url + `?cursor=${events.cursor(4)}`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ reason: "cursor_unknown" });
    const missing = await fetch(url.replace("/turn/", "/missing/"));
    expect(missing.status).toBe(410);
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
  const host = await startHost({ dataDir: directory, port: 0 }, [gateway]);
  try {
    const events = new ChatEvents(host);
    events.append({ streamId: "turn", kind: "delta", data: 1 });
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v2/streams/turn/events`, {
      headers: { "Last-Event-ID": events.cursor(1) },
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
