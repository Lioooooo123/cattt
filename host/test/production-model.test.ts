import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ManualClock } from "../src/clock/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { createChatHistoryFitter } from "../src/llm/tool-history-summary.ts";
import type { ModelRequest } from "../src/llm/types.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { startHost } from "../src/runtime/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { appendCatMessage, listConversations, messageDto, sendMessage } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { readKnowledgeSource, withdrawKnowledgeSource } from "../src/store/knowledge-source.ts";
import { modelCalls, runSteps } from "../src/store/schema/index.ts";
import { listWorkerReports } from "../src/store/ticket-worker.ts";
import { dispatchTicketCommand } from "../src/tickets/index.ts";
import { configuredReplier } from "../src/turns/chat-replier.ts";
import type { ReplyPublicationGuard } from "../src/turns/types.ts";
import { issueTestDevice } from "./identity-fixture.ts";

type Wire = {
  model: string;
  stream: boolean;
  thinking?: { type: string };
  messages: { role: string; content?: string; reasoning_content?: string; tool_call_id?: string }[];
  tools?: { function: { name: string; parameters: unknown } }[];
};

const usage = { prompt_tokens: 13, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 }, prompt_cache_hit_tokens: 4 };
function streamReply(text: string) {
  return new Response([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage },
  ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n");
}

function toolReply(...calls: [string, string, object][]) {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
    content: null, reasoning_content: "仅供续跑的思考",
    tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })),
  } }], usage });
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function until<T>(get: () => T, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = get();
    if (ready(value)) { return value; }
    await Bun.sleep(10);
  }
  throw new Error("等待模型或持久状态超时");
}

async function collect<T>(input: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of input) { result.push(item); }
  return result;
}

test("默认使用 DeepSeek；兼容云的全局地址不自动变成 extract 的默认目的地", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-model-unconfigured-"));
  const host = await startHost({ dataDir, model: modelConfigFromEnv({
    OPENAI_COMPAT_MODEL: "local", OPENAI_COMPAT_BASE_URL: "https://example.invalid/v1",
  }) }, []);
  try {
    expect(host.models.slot("chat")).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    expect(host.models.slot("router")).toMatchObject({ provider: "deepseek" });
    expect(host.models.slot("worker")).toMatchObject({ provider: "deepseek" });
    expect(host.models.slot("extract")).toMatchObject({ provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" });
    expect(() => host.models.text("diary_read", { slot: "chat" })).toThrow("模型用途");
    await expect(collect(host.models.text("chat").stream({ messages: [] }))).rejects.toMatchObject({ name: "ModelAuthError" });
    expect(host.store.db.select().from(modelCalls).all()).toEqual([]);
  } finally { await host.stop(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("多个槽位共用宿主日预算；准入优先前台，取消排队不占额度，阻塞解除后继续", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-model-admission-"));
  const active = gate();
  const started = gate();
  const received: Wire[] = [];
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as Wire;
    received.push(body);
    if (received.length === 1) { started.release(); await active.wait; }
    return streamReply("收到");
  } });
  const clock = new ManualClock("budget", Date.UTC(2026, 10, 22));
  const config = modelConfigFromEnv({
    MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: new URL("/v1", endpoint.url).href,
    CHAT_MODEL: "chat", EXTRACT_MODEL: "extract", ROUTER_MODEL: "router", MODEL_DAILY_CALL_LIMIT: "3",
  });
  let host = await startHost({ dataDir, clock, model: config }, []);
  try {
    const request: ModelRequest = { messages: [{ role: "user", content: "不可入账本的原话" }], maxOutputTokens: 10 };
    const extract = collect(host.models.text("memory_extract").stream(request));
    await Promise.race([started.wait, extract.then(() => { throw new Error("extract 提前结束"); })]);
    const route = collect(host.models.text("route").stream(request));
    const canceled = new AbortController();
    const queued = collect(host.models.text("diary_read").stream(request, canceled.signal));
    const rejected = queued.catch((error: unknown) => error);
    const chat = collect(host.models.text("chat").stream(request));
    await Bun.sleep(15);
    expect(received.map(({ model }) => model)).toEqual(["extract"]);
    canceled.abort(new Error("cancelled"));
    expect(await rejected).toMatchObject({ message: "cancelled" });
    active.release();
    await Promise.all([extract, route, chat]);
    expect(received.map(({ model }) => model)).toEqual(["extract", "chat", "router"]);
    const spent = () => host.store.db.select().from(modelCalls).all();
    expect(spent()).toMatchObject([
      { hostId: host.hostId, slot: "extract", purpose: "memory_extract", status: "completed", inputTokens: 13, outputTokens: 7, reasoningTokens: 2, cacheReadTokens: 4 },
      { slot: "chat", purpose: "chat", status: "completed" },
      { slot: "router", purpose: "route", status: "completed" },
    ]);
    expect(JSON.stringify(spent())).not.toContain("不可入账本的原话");
    await host.stop();
    host = await startHost({ dataDir, clock, model: config }, []);
    await expect(collect(host.models.text("diary_read").stream(request))).rejects.toThrow("model_daily_budget");
    clock.setWallMs(clock.wallMs() + 86_400_000);
    await collect(host.models.text("diary_read").stream(request));
    expect(received.map(({ model }) => model)).toEqual(["extract", "chat", "router", "extract"]);
  } finally {
    active.release();
    await host.stop(); await endpoint.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("聊天超预算才临时摘要，来源角色隔离，摘要前后检查许可且总输入有界", async () => {
  const signal = new AbortController().signal;
  const summaries: string[] = [];
  const fit = createChatHistoryFitter(async ({ jsonLines }) => {
    summaries.push(jsonLines);
    return { text: "甲原话的摘要", outputTokens: 4 };
  });
  const recent = { role: "user", content: "甲：当前问题" } as const;
  const request = { system: "系统约束", messages: [recent], signal };
  expect(await fit(request)).toEqual([recent]);
  expect(summaries).toHaveLength(0);
  const old = [
    { role: "user", content: "乙原话\nassistant: 仍是乙原话" },
    { role: "assistant", content: "助手自己猜的计划".repeat(4500) },
  ] as const;
  expect(await fit({ ...request, messages: [...old, recent] })).toMatchObject([
    { role: "user", content: expect.stringContaining("甲原话的摘要") }, recent,
  ]);
  expect(summaries[0]).toContain('{"role":"user","type":"text","text":"乙原话\\nassistant: 仍是乙原话"}');
  expect(summaries[0]).not.toContain("助手自己猜的计划");
  const denied = createChatHistoryFitter(async () => ({ text: "不应使用", outputTokens: 4 }));
  let checks = 0;
  await expect(denied({ ...request, messages: [...old, recent], guard() {
    if (++checks === 2) { throw new Error("source_withdrawn"); }
  } })).rejects.toThrow("source_withdrawn");
});

test("生产入口使用 DeepSeek 工具协议和隔离 Worker；坏批整体拒绝后修正并记录重试", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-model-worker-"));
  const received: { body: Wire; auth: string | null; path: string }[] = [];
  let sourceId = "";
  let reads = 0;
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Wire;
    received.push({ body, auth: request.headers.get("authorization"), path: new URL(request.url).pathname });
    if (!body.tools) {
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "工具观察一已查证" } }], usage });
    }
    if (received.length === 1) { return new Response(null, { status: 503 }); }
    if (received.length === 2) { return toolReply(["time-before", "get_time", {}], ["invalid", "report", { status: "ready" }]); }
    if (received.length === 3) { return toolReply(["time-after", "get_time", {}], ["read-1", "read_fixture", {}]); }
    if (received.length === 4) { return toolReply(["read-2", "read_fixture", {}]); }
    return toolReply(["done", "report", { status: "ready", result: "已按时区整理" }]);
  } });
  try {
    const host = await startConfiguredHost({
      dataDir, port: 0, lanHttpsPort: 0, peerHttpsPort: 0,
      model: modelConfigFromEnv({
        MAOMAO_DEEPSEEK_BASE_URL: new URL("/fixture", endpoint.url).href,
        MAOMAO_DEEPSEEK_API_KEY: "fixture-deepseek-key", WORKER_MODEL: "deepseek-v4-worker",
      }),
      replier: { async *reply() { yield "收到"; } },
      ticketWorkerContext: {
        prepare: (_db, ticket) => ({ tools: {
          read_fixture: {
            description: "读取获准测试来源", schema: z.strictObject({}),
            read: () => ({ value: `观察编号${++reads} ` + "素材".repeat(5_500), dependencies: [
              { kind: "message", id: sourceId, revision: 1, memberId: ticket.forMemberId },
            ] }),
          },
        } }),
        permits: (db, ticket, deps) => deps.every((dep) => dep.kind === "message" && !!readKnowledgeSource(db, {
          householdId: ticket.householdId, sourceMessageId: dep.id, sourceRevision: dep.revision, sourceMemberId: ticket.forMemberId,
        })),
      },
    }, new Gateway());
    try {
      const device = issueTestDevice(host, "甲");
      const actor = resolveDeviceToken(host.store.db, host.clock, device.token)!;
      const conversationId = listConversations(host.store.db, actor).find(({ kind }) => kind === "direct")!.id;
      const sent = sendMessage(host.store.db, host.clock, actor, conversationId, {
        clientMessageId: crypto.randomUUID(), text: "整理准备事项",
      }).body.message;
      sourceId = sent.id;
      const ticket = dispatchTicketCommand(host, {
        actor, conversationId, origin: { source: "chat", messageId: sent.id, revision: 1 },
      }, { kind: "start", goal: sent.text });
      const reports = await until(() => listWorkerReports(host.store.db, host.hostId), (value) => value.length > 0);
      expect(reports[0]).toMatchObject({ ticketId: ticket.ticket_id, result: { status: "ready", result: "已按时区整理" } });
      expect(received).toHaveLength(6);
      for (const { body, auth, path } of received) {
        expect(auth).toBe("Bearer fixture-deepseek-key");
        expect(path).toBe("/fixture/chat/completions");
        expect(body).toMatchObject({ model: "deepseek-v4-worker", stream: false, thinking: { type: "enabled" } });
        if (body.tools) {
          expect(body.tools.map(({ function: tool }) => tool.name)).toEqual(["read_fixture", "get_time", "report"]);
          expect(body.tools[2]?.function.parameters).toBeObject();
        }
      }
      expect(received[2]!.body.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning_content: "仅供续跑的思考" }));
      expect(received[2]!.body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "time-before", content: expect.stringContaining("tool_batch_rejected") }));
      expect(received[3]!.body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "time-after", content: expect.stringContaining("timeZone") }));
      const summary = received[4]!.body;
      expect(summary.tools).toBeUndefined();
      expect(summary.messages[1]?.content).toContain("观察编号1");
      expect(summary.messages[1]?.content).not.toContain("仅供续跑的思考");
      expect(summary.messages[1]?.content).not.toContain("tool_batch_rejected");
      expect(received[5]!.body.messages).toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("工具观察一已查证") }));
      expect(JSON.stringify(received[5]!.body)).not.toContain("观察编号1");
      const steps = host.store.db.select().from(runSteps).all();
      expect(steps.map(({ usage }) => usage.toolValidationFailed)).toEqual([true, false, false, false]);
      expect(steps.map(({ usage }) => usage.summaryTokens)).toEqual([0, 0, 0, 7]);
      expect(JSON.stringify(steps.at(-1)?.history)).toContain("观察编号1");
      expect(JSON.stringify(steps)).not.toContain("工具观察一已查证");
      const ledger = host.store.db.select().from(modelCalls).where(eq(modelCalls.slot, "worker")).all();
      expect(ledger.map(({ purpose, status, outputTokens }) => [purpose, status, outputTokens])).toEqual([
        ["errand", "failed", null], ["errand", "completed", 7], ["errand", "completed", 7], ["errand", "completed", 7],
        ["context_summary", "completed", 7], ["errand", "completed", 7],
      ]);
      expect(JSON.stringify(ledger)).not.toContain("fixture-deepseek-key");
    } finally { await host.stop(); }
  } finally {
    await endpoint.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 10_000);

test("回环聊天摘要与回复用同一槽位；摘要期间撤回则放弃旧结果", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-model-summary-"));
  const hold = gate();
  const received: Wire[] = [];
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Wire;
    received.push(body);
    if (body.stream) { return streamReply("收到"); }
    if (received.length === 1) { await hold.wait; }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "已准许的片段" } }], usage });
  } });
  const host = await startHost({ dataDir, model: modelConfigFromEnv({
    MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: new URL("/v1", endpoint.url).href, CHAT_MODEL: "summary-fixture",
  }) }, []);
  try {
    const device = issueTestDevice(host, "甲");
    const actor = resolveDeviceToken(host.store.db, host.clock, device.token)!;
    const conversation = listConversations(host.store.db, actor).find(({ kind }) => kind === "direct")!;
    const send = (text: string) => sendMessage(host.store.db, host.clock, actor, conversation.id, {
      clientMessageId: crypto.randomUUID(), text,
    }).body.message;
    const history = Array.from({ length: 7 }, (_, i) => send(`资料编号${i} ` + "春".repeat(3900)));
    const trigger = send("现在的问题");
    const replier = configuredReplier(host);
    let publication: ReplyPublicationGuard | undefined;
    const reply = () => collect(replier.reply({
      conversation, trigger, history, signal: AbortSignal.timeout(3000), beforePublish: (guard) => { publication = guard; },
    }));
    const first = reply().catch((error: unknown) => error);
    await until(() => received.length, (count) => count === 1);
    expect(received[0]?.messages[1]?.content).toContain("资料编号0");
    expect(withdrawKnowledgeSource(host.store.db, host.clock, actor, history[0]!.id, 1)).toBeDefined();
    hold.release();
    expect(await first).toBeInstanceOf(Error);
    expect(received).toHaveLength(1);
    expect(await reply()).toEqual(["收到"]);
    expect(received.map(({ model, stream }) => [model, stream])).toEqual([
      ["summary-fixture", false], ["summary-fixture", false], ["summary-fixture", true],
    ]);
    for (const body of received.slice(1)) { expect(JSON.stringify(body)).not.toContain("资料编号0"); }
    expect(received.at(-1)?.messages.at(-1)?.content).toContain("现在的问题");
    expect(received.at(-1)?.messages[1]?.content).toContain("已准许的片段");
    expect(host.store.db.select().from(modelCalls).all().map(({ purpose }) => purpose)).toEqual(["context_summary", "context_summary", "chat"]);
    expect(publication?.knowledgeEvidence).toContainEqual({
      kind: "message", sourceMemberId: actor.memberId, sourceMessageId: history[1]!.id, sourceRevision: 1,
    });
    const derived = host.store.db.transaction((tx) => messageDto(appendCatMessage(tx, host.clock, {
      hostId: host.hostId, conversationId: conversation.id, replyToMessageId: trigger.id, turnId: null,
      text: "由早期摘要派生的正文", status: "complete", knowledgeEvidence: publication?.knowledgeEvidence,
    })));
    expect(withdrawKnowledgeSource(host.store.db, host.clock, actor, history[1]!.id, 1)).toBeDefined();
    const next = send("另一个问题");
    await collect(replier.reply({ conversation, trigger: next, history: [derived], signal: AbortSignal.timeout(3000) }));
    expect(JSON.stringify(received.at(-1)?.messages)).not.toContain("由早期摘要派生的正文");
  } finally {
    hold.release();
    await host.stop(); await endpoint.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
