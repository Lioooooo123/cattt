import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents } from "../src/chat-events/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import type { Message, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { readChatEvents } from "../src/store/chat-events.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { acquireLease, LeaseLostError } from "../src/store/leases.ts";
import { messages } from "../src/store/schema/conversations.ts";
import { hosts, members } from "../src/store/schema/identity.ts";
import { turns } from "../src/store/schema/turns.ts";
import { claimTurn, finishTurn, getTurnRow, recoverTurns } from "../src/store/turns.ts";
import { TurnRunner } from "../src/turns/index.ts";
import type { Replier } from "../src/turns/types.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { testTurn } from "./turn-fixture.ts";

class Chunks implements AsyncIterableIterator<string> {
  private pending: { resolve: (result: IteratorResult<string>) => void; reject: (error: Error) => void } | undefined;
  private buffered: ({ value: string; done: false } | { done: true; value: undefined } | Error)[] = [];
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<string>> {
    const item = this.buffered.shift();
    if (item) {
      return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
    }
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  private emit(item: IteratorResult<string> | Error) {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (item instanceof Error) { pending.reject(item); } else { pending.resolve(item); }
    } else {
      this.buffered.push(item as typeof this.buffered[number]);
    }
  }
  push(value: string) { this.emit({ value, done: false }); }
  end() { this.emit({ done: true, value: undefined }); }
  fail() { this.emit(new Error("受控生成错误")); }
  async return(): Promise<IteratorResult<string>> { return { done: true, value: undefined }; }
}

class ControlledReplier implements Replier {
  calls: { input: Parameters<Replier["reply"]>[0]; chunks: Chunks }[] = [];
  reply(input: Parameters<Replier["reply"]>[0]) {
    const chunks = new Chunks();
    this.calls.push({ input, chunks });
    return chunks;
  }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) { return; }
    await Bun.sleep(1);
  }
  throw new Error("等待轮次条件超时");
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) { await stop(); } });

async function setup(run = true, options: ConstructorParameters<typeof TurnRunner>[0] = {}, clock?: ManualClock) {
  const directory = mkdtempSync(join(tmpdir(), "cattt-turns-"));
  const gateway = new Gateway({ heartbeatIntervalMs: 10 });
  const replier = new ControlledReplier();
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0, replier, clock }, run ? [new TurnRunner({ pollMs: 5, ...options }), gateway] : [gateway]);
  cleanup.push(async () => { await host.stop(); rmSync(directory, { recursive: true, force: true }); });
  const a = issueTestDevice(host, "甲");
  const b = issueTestDevice(host, "乙");
  const actor = (token: string) => resolveDeviceToken(host.store.db, host.clock, token)!;
  const [group, directA] = listConversations(host.store.db, actor(a.token));
  const directB = listConversations(host.store.db, actor(b.token))[1]!;
  const base = `http://127.0.0.1:${gateway.port}`;
  const request = (path: string, token = a.token, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, {
    method, signal: AbortSignal.timeout(4000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const send = async (conversationId: string, token: string, key: string = crypto.randomUUID(), text = key) => {
    const response = await request(`/v2/conversations/${conversationId}/messages`, token, { client_message_id: key, text });
    expect(response.status).toBe(201);
    return await response.json() as { message: Message; turn: Turn };
  };
  const turnPath = (turn: Turn) => `/v2/conversations/${turn.conversation_id}/turns/${turn.id}`;
  const terminal = async (turn: Turn) => {
    await until(() => ["completed", "stopped", "failed", "superseded"].includes(getTurnRow(host.store.db, turn.id)!.status));
    return await (await request(turnPath(turn), turn.conversation_id === directB.id ? b.token : a.token)).json() as Turn;
  };
  return { host, directory, replier, a, b, group: group!, directA: directA!, directB, actor, request, send, turnPath, terminal };
}

test("A、B 各自单聊生成 accepted/delta/done，持久猫回复与幂等原始响应，取消终态不覆写", async () => {
  const f = await setup();
  for (const [i, token, direct] of [[0, f.a.token, f.directA], [1, f.b.token, f.directB]] as const) {
    const sent = await f.send(direct.id, token, `dm-${i}`, "你好");
    await until(() => f.replier.calls.length > i);
    const call = f.replier.calls[i]!;
    expect(call.input.conversation.id).toBe(direct.id);
    expect(call.input.history.map((message) => message.id)).toEqual([sent.message.id]);
    call.chunks.push("你好");
    call.chunks.push("，喵");
    call.chunks.end();
    const completed = await f.terminal(sent.turn);
    expect(completed.status).toBe("completed");
    const stream = await f.request(sent.turn.stream_url, token);
    const text = await stream.text();
    expect(text).toContain(`event: accepted\ndata: ${JSON.stringify({ turn_id: sent.turn.id, trigger_message_id: sent.message.id })}`);
    expect(text).toContain('event: delta\ndata: {"text":"你好"}');
    expect(text).toContain(`event: done\ndata: ${JSON.stringify({ message_id: completed.reply_message_id, status: "completed" })}`);
    const cat = f.host.store.db.select().from(messages).where(eq(messages.id, completed.reply_message_id!)).get()!;
    expect(cat).toMatchObject({ text: "你好，喵", authorMemberId: null, replyToMessageId: sent.message.id, turnId: sent.turn.id, status: "complete" });
    const replay = await f.request(`/v2/conversations/${direct.id}/messages`, token, { client_message_id: `dm-${i}`, text: "你好" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(sent);
    expect(await (await f.request(f.turnPath(sent.turn) + "/cancel", token, { visible_length: 0 })).json()).toEqual(completed);
    const retryCat = await f.request(`/v2/conversations/${direct.id}/messages/${cat.id}/reply`, token, { request_id: crypto.randomUUID() });
    expect(retryCat.status).toBe(404);
  }
});

test("群聊 B 取代 A 首 token 前的轮次，新历史同时含两人的署名，迟到块无效", async () => {
  const f = await setup(true, { historyLimit: 2 });
  const first = await f.send(f.group.id, f.a.token, "a", "团子，甲说");
  await until(() => f.replier.calls.length === 1);
  const second = await f.send(f.group.id, f.b.token, "b", "团子，乙说");
  await until(() => f.replier.calls.length === 2);
  expect((await f.terminal(first.turn)).status).toBe("superseded");
  const oldStream = await (await f.request(first.turn.stream_url)).text();
  expect(oldStream).toContain(`event: superseded\ndata: ${JSON.stringify({ turn_id: first.turn.id, by_turn_id: second.turn.id })}`);
  expect(f.replier.calls[0]!.input.signal.aborted).toBe(true);
  const call = f.replier.calls[1]!;
  expect(call.input.history.map((message) => message.id)).toEqual([first.message.id, second.message.id]);
  expect(call.input.history.map((message) => message.author)).toEqual([first.message.author, second.message.author]);
  f.replier.calls[0]!.chunks.push("过期结果");
  call.chunks.push("一起聊");
  call.chunks.end();
  expect((await f.terminal(second.turn)).status).toBe("completed");
  expect(f.host.store.db.select().from(messages).all().filter((row) => row.authorMemberId === null).map((row) => row.text)).toEqual(["一起聊"]);
});

test("已有首 token 不被取代，同一会话串行而不同单聊可并行", async () => {
  const f = await setup();
  const first = await f.send(f.group.id, f.a.token, crypto.randomUUID(), "团子，你在吗？");
  await until(() => f.replier.calls.length === 1);
  f.replier.calls[0]!.chunks.push("已开口");
  await until(() => getTurnRow(f.host.store.db, first.turn.id)!.firstTokenAt !== null);
  const second = await f.send(f.group.id, f.b.token, crypto.randomUUID(), "团子，你想聊吗？");
  expect(getTurnRow(f.host.store.db, first.turn.id)!.status).toBe("generating");
  const dm = await f.send(f.directB.id, f.b.token);
  await until(() => f.replier.calls.length === 2);
  expect(f.replier.calls[1]!.input.conversation.id).toBe(f.directB.id);
  f.replier.calls[0]!.chunks.end();
  await f.terminal(first.turn);
  await until(() => f.replier.calls.length === 3);
  expect(f.replier.calls[2]!.input.trigger.id).toBe(second.message.id);
  f.replier.calls[1]!.chunks.push("单聊"); f.replier.calls[1]!.chunks.end();
  f.replier.calls[2]!.chunks.push("群聊"); f.replier.calls[2]!.chunks.end();
  await f.terminal(dm.turn); await f.terminal(second.turn);
});

for (const [length, expected] of [[3, "A😀"], [2, "A"], [0, ""]] as const) {
  test(`流中取消按 UTF-16 上限 ${length} 截断、幂等且忽略迟到结果`, async () => {
    const f = await setup();
    const sent = await f.send(f.directA.id, f.a.token);
    await until(() => f.replier.calls.length === 1);
    f.replier.calls[0]!.chunks.push("A😀尾");
    await until(() => getTurnRow(f.host.store.db, sent.turn.id)!.draftText === "A😀尾");
    const cancel = await f.request(f.turnPath(sent.turn) + "/cancel", f.a.token, { visible_length: length });
    expect(cancel.status).toBe(200);
    const stopped = await f.terminal(sent.turn);
    expect(stopped.status).toBe("stopped");
    expect(await (await f.request(f.turnPath(sent.turn) + "/cancel", f.a.token, { visible_length: 100 })).json()).toEqual(stopped);
    f.replier.calls[0]!.chunks.push("迟到"); f.replier.calls[0]!.chunks.end();
    const snapshot = await (await f.request(sent.turn.stream_url + "?last_event_id=bad")).text();
    expect(snapshot).toContain(`event: snapshot\ndata: ${JSON.stringify({ text: expected })}`);
    expect(snapshot).toContain('"status":"stopped"');
    const cats = f.host.store.db.select().from(messages).all().filter((row) => row.authorMemberId === null);
    expect(cats.map((row) => row.text)).toEqual(expected ? [expected] : []);
  });
}

test("queued 取消与重答幂等、不同目标冲突；嵌套资源、单聊与发布宿主校验", async () => {
  const f = await setup(false);
  const first = await f.send(f.directA.id, f.a.token);
  const prefix = f.turnPath(first.turn);
  expect((await f.request(prefix, f.b.token)).status).toBe(404);
  expect((await f.request(first.turn.stream_url, f.b.token)).status).toBe(404);
  expect((await f.request(prefix + "/cancel", f.b.token, {})).status).toBe(404);
  expect((await f.request(`/v2/conversations/${f.directA.id}/messages/${first.message.id}/reply`, f.b.token, { request_id: crypto.randomUUID() })).status).toBe(404);
  expect((await f.request(`/v2/conversations/${f.group.id}/turns/${first.turn.id}`)).status).toBe(404);
  for (const visible_length of [-1, 1.5, "bad", null]) {
    expect((await f.request(prefix + "/cancel", f.a.token, { visible_length })).status).toBe(400);
  }
  expect((await (await f.request(prefix + "/cancel", f.a.token, { visible_length: 0 })).json() as Turn).status).toBe("stopped");
  const target = `/v2/conversations/${f.directA.id}/messages/${first.message.id}/reply`;
  expect((await f.request(target, f.a.token, {})).status).toBe(400);
  const request_id = crypto.randomUUID();
  const retry = await f.request(target, f.a.token, { request_id });
  expect(retry.status).toBe(201);
  const retried = await retry.json() as Turn;
  const replay = await f.request(target, f.a.token, { request_id });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(retried);
  const second = await f.send(f.directA.id, f.a.token);
  const conflict = await f.request(`/v2/conversations/${f.directA.id}/messages/${second.message.id}/reply`, f.a.token, { request_id });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: { code: "idempotency_conflict" } });
  const remote = businessRow(f.host.clock, f.host.hostId);
  f.host.store.db.insert(hosts).values({ ...remote, householdId: f.host.householdId, displayName: "另一台 Mac" }).run();
  f.host.store.db.update(members).set({ homeHostId: remote.id }).where(eq(members.id, f.a.memberId)).run();
  for (const path of [f.turnPath(second.turn) + "/cancel", target]) {
    const response = await f.request(path, f.a.token, { request_id: crypto.randomUUID() });
    if (path.endsWith("/cancel")) {
      expect(response.status).toBe(400);
      const valid = await f.request(path, f.a.token, {});
      expect(valid.status).toBe(409);
      expect(await valid.json()).toEqual({ error: { code: "not_publisher" } });
    } else {
      expect(response.status).toBe(409);
    }
  }
  expect((await f.request("/v2/streams/old/events")).status).toBe(404);
});

test("生成抛错、空回复和预算超时产生 failed/error，非协作生成不阻塞停止", async () => {
  for (const mode of ["throw", "empty", "timeout"] as const) {
    const f = await setup(true, { budgetMs: mode === "timeout" ? 30 : 4000 });
    const sent = await f.send(f.directA.id, f.a.token);
    await until(() => f.replier.calls.length === 1);
    const chunks = f.replier.calls[0]!.chunks;
    if (mode === "throw") { chunks.fail(); }
    if (mode === "empty") { chunks.end(); }
    const failed = await f.terminal(sent.turn);
    expect(failed).toMatchObject({ status: "failed", error_code: mode === "throw" ? "replier_error" : mode === "empty" ? "empty_reply" : "budget_exceeded", reply_message_id: null });
    expect(await (await f.request(sent.turn.stream_url)).text()).toContain(`event: error\ndata: ${JSON.stringify({ code: failed.error_code, retryable: true })}`);
    chunks.push("迟到"); chunks.end();
    await f.host.stop();
  }
});

test("事件与轮次回滚不唤醒，旧 epoch 不能发布最终猫消息，恢复只发 interrupted", async () => {
  const clock = new ManualClock("test", 100);
  const f = await setup(false, {}, clock);
  let wakes = 0;
  const remove = f.host.bus.subscribe("chat:event", () => { wakes += 1; });
  expect(() => new ChatEvents(f.host).write((db, append) => {
    sendMessage(db, clock, f.actor(f.a.token), f.group.id, { clientMessageId: "rollback", text: "回滚" }, append);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(wakes).toBe(0);
  expect(f.host.store.db.select().from(turns).all()).toEqual([]);
  remove();
  const running = testTurn(f.host, f.a.token);
  running.delta("旧运行器");
  clock.advance(3600_001);
  const lease = acquireLease(f.host.store.db, clock, { name: running.fence.name, holder: "new-worker", ttlMs: 1000, skewMs: 0 });
  expect(lease.acquired).toBe(true);
  expect(() => finishTurn(f.host.store.db, clock, running.turn.id, { status: "completed", fence: running.fence })).toThrow(LeaseLostError);
  expect(f.host.store.db.select().from(messages).all()).toHaveLength(1);
  new ChatEvents(f.host).write((db, append) => recoverTurns(db, clock, 60_000, true, append));
  expect(getTurnRow(f.host.store.db, running.turn.id)).toMatchObject({ status: "failed", errorCode: "interrupted" });
  expect(readChatEvents(f.host.store.db, clock, running.turn.id).at(-1)).toMatchObject({ kind: "error", data: { code: "interrupted", retryable: true }, terminal: true });
});

test("启动恢复 stale queued/generating 轮次，不重跑旧生成，快照保留 interrupted 终态", async () => {
  const clock = new ManualClock("test", 100);
  const f = await setup(false, {}, clock);
  const queued = await f.send(f.directA.id, f.a.token);
  const generating = await f.send(f.directB.id, f.b.token);
  const name = `conversation:${f.directB.id}`;
  const lease = acquireLease(f.host.store.db, clock, { name, holder: "crashed", ttlMs: 1000 });
  claimTurn(f.host.store.db, clock, generating.turn.id, { name, holder: "crashed", epoch: lease.epoch });
  await f.host.stop();
  clock.advance(60_001);
  const recovered = await startHost({ dataDir: f.directory, clock, replier: f.replier }, [new TurnRunner()]);
  try {
    for (const id of [queued.turn.id, generating.turn.id]) {
      expect(getTurnRow(recovered.store.db, id)).toMatchObject({ status: "failed", errorCode: "interrupted" });
      expect(readChatEvents(recovered.store.db, clock, id).at(-1)).toMatchObject({ kind: "error", data: { code: "interrupted", retryable: true } });
    }
    expect(f.replier.calls).toHaveLength(0);
  } finally { await recovered.stop(); }
});

test("停止不等待忽略 signal 的生成器，收尾 interrupted 并释放会话租约", async () => {
  const f = await setup();
  const sent = await f.send(f.directA.id, f.a.token);
  await until(() => f.replier.calls.length === 1);
  await f.host.stop();
  expect(f.replier.calls[0]!.input.signal.aborted).toBe(true);
  const reopened = await startHost({ dataDir: f.directory }, []);
  try {
    expect(getTurnRow(reopened.store.db, sent.turn.id)).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(acquireLease(reopened.store.db, reopened.clock, { name: `conversation:${f.directA.id}`, holder: "next-worker", ttlMs: 1000 }).acquired).toBe(true);
  } finally { await reopened.stop(); }
});
