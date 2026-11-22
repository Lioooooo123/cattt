import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents } from "../src/chat-events/index.ts";
import { SystemClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { leases, mailboxLetters, messages, modelCalls, peerInbox, publicationReceipts, ticketInputs, tickets, triggers, turns } from "../src/store/schema/index.ts";
import { releaseLease } from "../src/store/leases.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { cancelTurn } from "../src/store/turns.ts";

const baseTime = Date.now();
const day = (days: number) => new Date(baseTime + days * 86_400_000).toISOString().slice(0, 10);
const when = `${day(1)}T20:00:00`;
const later = `${day(2)}T19:00:00`;
const schedule = "我们约好明天晚上八点聊面试。";
const start = "团子，请帮我整理三条露营清单。";
const utterance = {
  reschedule: "把面试约定改到后天晚上七点。",
  append: "给露营清单补充：尽量轻装。",
  cancel: "取消面试约定。",
};

type Message = { role: string; content: string };
type Wire = { model: string; stream: boolean; messages: Message[]; tools?: { function: { name: string } }[] };
type Call = [name: string, args: Record<string, unknown>];
const proposal: Call = ["schedule_followup", { when, about: "面试" }];
const usage = { prompt_tokens: 120, completion_tokens: 24 };

function gate() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { entered: entered.promise, release: () => release.resolve(), async wait() { entered.resolve(); await release.promise; } };
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  const deadline = performance.now() + 25000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error(`等待超时：${JSON.stringify(value)}`);
    await Bun.sleep(30);
  }
}

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cattt-ticket-chat-"));
  const stops: (() => unknown)[] = [];
  async function setup() {
    const wire: Wire[] = [];
    const errors: unknown[] = [];
    const workerGate = gate();
    stops.push(workerGate.release);
    let script: (body: Wire) => Call[] | Promise<Call[]> = () => [proposal];
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as Wire;
      wire.push(body);
      if (body.stream) return new Response([
        'data: {"choices":[{"delta":{"content":"我在听。"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]', '',
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      const worker = body.model === "worker-fixture";
      if (worker) await workerGate.wait();
      const calls = worker ? [["report", { status: "ready", result: "检查帐篷、照明和饮水。" }] as Call] : await script(body);
      return Response.json({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: {
        content: "已经全部办好了。", reasoning_content: "内部草稿",
        tool_calls: calls.map(([name, args]) => ({
          id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
        })),
      } }], usage });
    } });
    stops.unshift(() => model.stop(true));
    const config = modelConfigFromEnv({ MODEL_PROVIDER: "openai-compatible", CHAT_PROVIDER: "openai-compatible",
      WORKER_PROVIDER: "openai-compatible", CHAT_MODEL: "chat-fixture", WORKER_MODEL: "worker-fixture",
      OPENAI_COMPAT_BASE_URL: new URL("/v1", model.url).href, MODEL_LOCAL_CONCURRENCY: "2" });
    async function launch(name: string) {
      const dataDir = join(root, name);
      const clock = new SystemClock(name);
      const offset = 12 - new Date().getUTCHours();
      const publicationZone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
      const gateway = new Gateway({ peerPort: 0, peerHostname: "127.0.0.1", lanPort: 0 });
      const host = await startConfiguredHost({ dataDir, clock, port: 0, model: config,
        onError: (error) => { errors.push(error); },
        ticketAdmission: { timeZone: () => "UTC", publicationTimeZone: () => publicationZone },
      }, gateway);
      stops.splice(1, 0, host.stop);
      const ca = readFileSync(join(dataDir, "tls/ca.crt"), "utf8");
      const admin = readFileSync(join(dataDir, "host-admin.token"), "utf8").trim();
      function request(path: string, method = "GET", body?: unknown, token?: string, phone = token !== undefined) {
        return fetch((phone ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`) + path, {
          method, tls: { ca }, signal: AbortSignal.timeout(15000),
          headers: { "content-type": "application/json",
            ...(!phone || token ? { authorization: `Bearer ${token ?? admin}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }
      async function call(path: string, method?: string, body?: unknown, token?: string, phone?: boolean) {
        const r = await request(path, method, body, token, phone);
        return { status: r.status, body: await r.json() };
      }
      return { host, db: host.store.db, request, call };
    }
    const a = await launch("a");
    const alice = (await a.call("/host/members", "POST", { display_name: "甲" })).body.member.id as string;
    const code = (await a.call("/host/pairing-codes", "POST", { member_id: alice })).body.code;
    const token = (await a.call("/v2/pair", "POST", { code, device_name: "甲手机" }, undefined, true)).body.device_token as string;
    return { a, alice, token, launch, wire, errors, workerGate, script: (next: typeof script) => { script = next; } };
  }
  try { await run(await setup()); }
  finally {
    for (const stop of [...stops].reverse()) await stop();
    rmSync(root, { recursive: true, force: true });
  }
}

type Node = { request(path: string, method?: string, body?: unknown, token?: string): Promise<Response>;
  call(path: string, method?: string, body?: unknown, token?: string): Promise<{ status: number; body: any }> };

async function conversation(node: Node, token: string, kind = "direct") {
  const { body } = await node.call("/v2/conversations", undefined, undefined, token);
  return body.conversations.find((row: { kind: string }) => row.kind === kind)?.id as string;
}

const send = (node: Node, token: string, id: string, text: string, key = crypto.randomUUID()) =>
  node.call(`/v2/conversations/${id}/messages`, "POST", { client_message_id: key, text }, token);
const retry = (node: Node, token: string, id: string, source: string) =>
  node.call(`/v2/conversations/${id}/messages/${source}/reply`, "POST", { request_id: crypto.randomUUID() }, token);
async function reply(node: Node, token: string, url: string) {
  const response = await node.request(url, undefined, undefined, token);
  expect(response.status).toBe(200);
  const frames = await response.text();
  return { frames, text: [...frames.matchAll(/^event: delta\ndata: (.*)$/gm)].map((m) => JSON.parse(m[1]!).text).join("") };
}

test("无明确事项授权的原话保持一次流式聊天，旧提议和推测不会进入工具阶段", async () => {
  await fixture(async ({ a, token, wire }) => {
    const id = await conversation(a, token);
    for (const text of [
      "我明天晚上八点有面试，好紧张。",
      "记住，我喜欢明天晚上八点弹琴。",
      "如果明天晚上八点有空，我们再聊面试。",
      "团子以前说「我们约好明天晚上八点聊面试」。",
      "我没有要你帮我整理露营清单。",
      "请帮我记住，我喜欢露营。",
      "我们约好明晚聊面试。",
      "我们约好明天晚上八点。",
      "我们约好明天八点聊面试。",
      "你说要帮我整理露营清单，是真的吗？",
      "我们约好明天晚上八点聊面试了吗？",
      "请帮我整理露营清单，但不要真的去办。",
      "我们约好明天晚上八点聊面试，我在举例。",
    ]) {
      const sent = await send(a, token, id, text);
      expect((await reply(a, token, sent.body.turn.stream_url)).text, text).toBe("我在听。");
    }
    expect(wire.filter(({ model }) => model === "chat-fixture").map(({ stream }) => stream)).toEqual(Array(13).fill(true));
    expect(a.db.select().from(triggers).all()).toHaveLength(0);
  });
}, 60000);

test("约定和托付从实际工具收据答复，坏批、改期、补充、取消和重答经统一准入", async () => {
  await fixture(async ({ a, token, wire, script }) => {
    const id = await conversation(a, token);
    script((body) => body.messages.at(-1)?.role === "tool" ? [proposal] : [proposal, ["unknown_tool", {}]]);
    const key = crypto.randomUUID();
    const sent = await send(a, token, id, schedule, key);
    const confirmation = await reply(a, token, sent.body.turn.stream_url);
    expect(confirmation.text).toContain(`${day(1)} 20:00`);
    expect(confirmation.frames).not.toContain("已经全部办好");
    expect(confirmation.frames).not.toContain("内部草稿");
    expect(wire.slice(0, 2).map(({ stream }) => stream)).toEqual([false, false]);
    expect(wire[1]!.messages.at(-1)?.content).toContain("unknown_tool");
    const agreement = a.db.select().from(tickets).get()!;
    expect(a.db.select().from(triggers).all()).toHaveLength(1);
    expect((await send(a, token, id, schedule, key)).status).toBe(200);
    const beforeRetry = wire.length;
    const existing = await retry(a, token, id, sent.body.message.id);
    expect((await reply(a, token, existing.body.stream_url)).text).toContain(`当时约的是 ${day(1)} 20:00`);
    expect(wire.length).toBe(beforeRetry);
    const badTime = "后天晚上八点我们聊面试吧。";
    const rejected = await send(a, token, id, badTime);
    expect((await reply(a, token, rejected.body.turn.stream_url)).text).toContain("没有保存");
    expect(a.db.select().from(triggers).all()).toHaveLength(1);

    const change = async (text: string, call: Call) => {
      script((body) => body.messages.at(-1)?.role === "tool" ? [call] : [["list_tickets", {}]]);
      const result = await send(a, token, id, text);
      return reply(a, token, result.body.turn.stream_url);
    };
    expect((await change(utterance.reschedule, ["update_ticket", { ticket_id: agreement.id, when: later }])).text)
      .toContain(`${day(2)} 19:00`);
    script(() => [["start_errand", { goal: "整理三条露营清单" }]]);
    const errand = await send(a, token, id, start);
    expect((await reply(a, token, errand.body.turn.stream_url)).text).toContain("已经记下");
    const task = a.db.select().from(tickets).all().find(({ kind }) => kind === "errand")!;
    expect((await change(utterance.append, ["update_ticket", { ticket_id: task.id, text: "模型改写" }])).text).toContain("补充");
    expect(a.db.select().from(ticketInputs).all().map(({ text }) => text)).toEqual([utterance.reschedule, utterance.append]);
    const cancelled = await change(utterance.cancel, ["cancel_ticket", { ticket_id: agreement.id }]);
    expect(cancelled.text).toContain("已取消");
    expect(a.db.select().from(tickets).where(eq(tickets.id, agreement.id)).get()?.stage).toBe("cancelled");
    expect(a.db.select().from(triggers).all()).toHaveLength(5);
    expect(a.db.select().from(modelCalls).where(eq(modelCalls.turnId, sent.body.turn.id)).all()).toMatchObject([
      { purpose: "chat", slot: "chat", status: "completed", outputTokens: 24 },
      { purpose: "chat", slot: "chat", status: "completed", outputTokens: 24 },
    ]);
  });
}, 75000);

test("停止、撤回与执行租约丢失挡住晚到写入，失败重答不会重新执行", async () => {
  await fixture(async ({ a, token, script, wire }) => {
    const id = await conversation(a, token);
    for (const mode of ["cancel", "withdraw", "revision", "lease"] as const) {
      const pause = gate();
      script(async () => { await pause.wait(); return [proposal]; });
      const sent = await send(a, token, id, schedule);
      await until(() => Promise.race([pause.entered.then(() => true), Bun.sleep(50).then(() => false)]), Boolean);
      try {
        if (mode === "cancel") {
          expect((await a.call(`/v2/conversations/${id}/turns/${sent.body.turn.id}/cancel`, "POST", {}, token)).status).toBe(200);
        } else if (mode === "withdraw") {
          expect((await a.call(`/v2/conversations/${id}/messages/${sent.body.message.id}/withdraw`, "POST", {
            request_id: crypto.randomUUID(), expected_revision: 1,
          }, token)).status).toBe(200);
        } else if (mode === "revision") {
          a.db.update(messages).set({ rev: 2 }).where(eq(messages.id, sent.body.message.id)).run();
        } else {
          const row = a.db.select().from(leases).where(eq(leases.name, `conversation:${id}`)).get()!;
          releaseLease(a.db, a.host.clock, row.name, row.holder, row.epoch);
        }
      } finally { pause.release(); }
      if (mode === "lease") await until(() => a.db.select().from(modelCalls).where(eq(modelCalls.turnId, sent.body.turn.id)).get(),
        (call) => call?.status === "completed");
      if (mode === "revision") {
        expect((await reply(a, token, sent.body.turn.stream_url)).text).toBe("");
      } else if (mode !== "withdraw") {
        const before = wire.length;
        const again = await retry(a, token, id, sent.body.message.id);
        expect((await reply(a, token, again.body.stream_url)).text).toContain("没有保存");
        expect(wire.length).toBe(before);
      }
      expect(a.db.select().from(triggers).all()).toHaveLength(0);
    }

    // 在事项提交和正文发布之间停止轮次，模拟收据已经写入但回复未到达。
    const actor = resolveDeviceToken(a.db, a.host.clock, token)!;
    const pause = gate();
    script(async () => { await pause.wait(); return [proposal]; });
    const sent = await send(a, token, id, schedule);
    await pause.entered;
    const unsubscribe = a.host.bus.subscribe("jobs:wake", ({ queue }) => {
      if (queue !== "followup") return;
      new ChatEvents(a.host).write((db, append) => cancelTurn(db, a.host.clock, actor, id, sent.body.turn.id, 0, append, a.host.publication));
    });
    try {
      pause.release();
      expect((await reply(a, token, sent.body.turn.stream_url)).text).toBe("");
    } finally { unsubscribe(); }
    expect(a.db.select().from(triggers).all()).toHaveLength(1);
    const before = wire.length;
    const recovered = await retry(a, token, id, sent.body.message.id);
    expect((await reply(a, token, recovered.body.stream_url)).text).toContain(`当时约的是 ${day(1)} 20:00`);
    expect(wire.length).toBe(before);
    expect(a.db.select().from(triggers).all()).toHaveLength(1);
  });
}, 75000);

test("双 SQLite 经 HTTPS 和 mTLS 转投群聊；成员隔离、收据复制及 Router 只发布一次", async () => {
  await fixture(async ({ a, alice, token, launch, script, workerGate, errors }) => {
    const b = await launch("b");
    const ad = (await a.call("/host/peer-identity")).body;
    const bd = (await b.call("/host/peer-identity")).body;
    expect((await a.call(`/host/peers/${bd.host_id}`, "PUT", {
      identity: bd, confirmed_fingerprint: bd.fingerprint, allow_join: true,
    })).status).toBe(200);
    expect((await b.call("/host/peers/connect", "POST", {
      identity: ad, confirmed_fingerprint: ad.fingerprint, join_household: true,
    })).status).toBe(200);
    const invite = await until(() => b.call("/host/invites", "POST", { display_name: "乙" }), ({ status }) => status === 200);
    const joined = await b.call("/v2/invites/accept", "POST", {
      code: invite.body.code, display_name: "乙", device_name: "乙手机",
    }, undefined, true);
    expect(joined.status).toBe(200);
    const bob = joined.body.device_token as string;
    const group = await conversation(a, token, "group");
    await until(() => conversation(b, bob, "group"), (id) => id === group);
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");

    const forwarded = `团子，${schedule}`;
    const key = crypto.randomUUID();
    const pending = await send(b, bob, group, forwarded, key);
    expect(pending.status).toBe(202);
    const received = await until(() => b.call(pending.body.receipt_url, "GET", undefined, bob), ({ status }) => status === 200);
    const source = received.body.message.id as string;
    const first = await until(() => a.db.select().from(turns).where(eq(turns.triggerMessageId, source)).get(),
      (turn) => turn?.status === "completed");
    expect(first?.draftText).toContain(`${day(1)} 20:00`);
    expect(a.db.select().from(peerInbox).all().length).toBeGreaterThan(0);
    const agreement = a.db.select().from(tickets).get()!;
    expect(agreement).toMatchObject({ forMemberId: joined.body.member.id, publisherHostId: a.host.hostId, sourceMessageId: source });
    expect(a.db.select().from(triggers).all()).toHaveLength(1);
    expect((await send(b, bob, group, forwarded, key)).status).toBe(200);
    await until(() => b.db.select().from(triggers).all(), (rows) => rows.length === 1);
    expect(b.db.select().from(turns).where(eq(turns.triggerMessageId, source)).all()).toHaveLength(0);

    script((body) => body.messages.at(-1)?.role === "tool" ? [["cancel_ticket", { ticket_id: agreement.id }]] : [["list_tickets", {}]]);
    const wrong = await send(a, token, group, "团子，取消面试约定。");
    expect((await reply(a, token, wrong.body.turn.stream_url)).text).not.toContain("已取消");
    expect(a.db.select().from(triggers).all()).toHaveLength(1);
    const wrongRetry = await retry(a, token, group, source);
    expect((await reply(a, token, wrongRetry.body.stream_url)).text).not.toContain("当时约的是");
    expect(agreement.forMemberId).not.toBe(alice);

    script(() => [["start_errand", { goal: "整理三条露营清单" }]]);
    const sent = await send(b, bob, group, start);
    expect(sent.status).toBe(202);
    const delegated = await until(() => b.call(sent.body.receipt_url, "GET", undefined, bob), ({ status }) => status === 200);
    const errandSource = delegated.body.message.id as string;
    const errandTurn = await until(() => a.db.select().from(turns).where(eq(turns.triggerMessageId, errandSource)).get(),
      (row) => row?.status === "completed");
    expect(errandTurn?.draftText).toContain("已经记下");
    workerGate.release();
    await until(() => a.db.select().from(publicationReceipts).all(), (rows) =>
      rows.some((row) => row.status !== "pending"));
    expect(a.db.select().from(publicationReceipts).all()).toMatchObject([{ status: "published", reason: null }]);
    const letters = a.db.select().from(mailboxLetters).where(eq(mailboxLetters.forMemberId, joined.body.member.id)).all();
    expect(letters.map(({ text }) => text)).toEqual(["检查帐篷、照明和饮水。"]);
    expect(a.db.select().from(triggers).all()).toHaveLength(2);
    const handoff = { request_id: crypto.randomUUID(), expected_epoch: 1 };
    await until(() => a.call(`/host/peers/${b.host.hostId}/lease`, "POST", handoff), ({ status }) => status === 200);
    await until(() => b.call("/host/publication-lease"), ({ body }) => body.status === "ready" && body.epoch === 2);
    const recovered = await retry(b, bob, group, errandSource);
    expect(recovered.status).toBe(201);
    expect((await reply(b, bob, recovered.body.stream_url)).text).toContain("当时已经记下");
    expect(a.db.select().from(triggers).all()).toHaveLength(2);
    expect(b.db.select().from(triggers).all()).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}, 120000);
