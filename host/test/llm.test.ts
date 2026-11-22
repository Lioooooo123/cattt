import { expect, test } from "bun:test";
import { chatSpec, modelConfigFromEnv, thinkingOptions } from "../src/llm/config.ts";
import { classifyModelError, ModelAuthError, ModelHttpError, ModelOutputError, ModelReplyError, retryableModelCode } from "../src/llm/errors.ts";
import { createChatModel } from "../src/llm/index.ts";
import { createMockModel } from "../src/llm/mock.ts";
import { createDeepSeek, createOpenAICompatible } from "../src/llm/openai-compatible.ts";
import type { ModelClient } from "../src/llm/types.ts";
import { buildChatPrompt, ChatReplier, configuredReplier } from "../src/turns/chat-replier.ts";
import { DevelopmentEchoReplier } from "../src/turns/development-replier.ts";
import type { Replier } from "../src/turns/types.ts";
import type { HostContext } from "../src/runtime/index.ts";
import { configFromEnv } from "../src/runtime/config.ts";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) { result.push(value); }
  return result;
}

export function promptInput(kind: "direct" | "group" = "direct"): Parameters<Replier["reply"]>[0] {
  const trigger = {
    id: "message", conversation_id: "conversation", cursor: "opaque", author: { kind: "member" as const, member_id: "a" },
    text: "今天有点累\n陪我坐一会儿", modality: "text" as const, status: "complete" as const, client_message_id: "key",
    reply_to_message_id: null, turn_id: "turn", created_at: 100,
  };
  return { conversation: { id: "conversation", kind, owner_member_id: kind === "direct" ? "a" : null, participant_member_ids: kind === "direct" ? ["a"] : ["a", "b"], publisher_host_id: "host", created_at: 100, last_message: trigger }, history: [trigger], trigger, signal: new AbortController().signal };
}

test("模型配置沿用来源、聊天槽位和思考参数；仅显式 echo 选择开发回复，mock 覆盖来源", async () => {
  expect(configFromEnv({}).model?.MODEL_PROVIDER).toBe("deepseek");
  expect(configFromEnv({ MODEL_PROVIDER: "echo", CHAT_PROVIDER: "deepseek" }).model?.MODEL_PROVIDER).toBe("echo");
  for (const value of [undefined, "echo", "mock", "openai-compatible", "deepseek"]) {
    const ctx = { config: { dataDir: "unused", model: modelConfigFromEnv({ MODEL_PROVIDER: value }) } } as HostContext;
    const replier = configuredReplier(ctx);
    expect(replier instanceof DevelopmentEchoReplier).toBe(value === "echo");
    expect(replier instanceof ChatReplier).toBe(value !== "echo");
  }
  const config = modelConfigFromEnv({ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_MODEL: "local", CHAT_PROVIDER: "deepseek", CHAT_MODEL: "chat-model", CHAT_THINKING: "enabled" });
  expect(chatSpec(config)).toEqual({ provider: "deepseek", model: "chat-model" });
  expect(chatSpec(modelConfigFromEnv({ MODEL_PROVIDER: "deepseek" })).model).toBe("deepseek-flash");
  expect(chatSpec(modelConfigFromEnv({ MODEL_PROVIDER: "mock", CHAT_PROVIDER: "deepseek" }))).toEqual({ provider: "mock", model: "mock-chat" });
  expect(thinkingOptions("deepseek", config)).toEqual({ thinking: { type: "enabled" } });
  const local = modelConfigFromEnv({ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_MODEL: "local" });
  expect(thinkingOptions("openai-compatible", local)).toEqual({ reasoning_effort: "none" });
  expect(thinkingOptions("openai-compatible", { ...local, CHAT_THINKING: "enabled" })).toEqual({});
  expect(thinkingOptions("openai-compatible", { ...local, OPENAI_COMPAT_THINKING_PARAM: "none" })).toEqual({});
  expect(thinkingOptions("openai-compatible", { ...local, OPENAI_COMPAT_THINKING_PARAM: "chat_template_kwargs" })).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  const mock = createChatModel(modelConfigFromEnv({ MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0" }));
  expect((await collect(mock.stream({ messages: [] }))).at(-1)).toEqual({ type: "finish", finishReason: "stop" });
});

test("配置错误仅给字段名，不泄露密钥、非法 URL 或输入值", () => {
  for (const value of ["not-a-url-PRIVATE_KEY", "https://user:PRIVATE_KEY@example.com/v1", "file:///PRIVATE_KEY"]) {
    try {
      modelConfigFromEnv({ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: value, MAOMAO_OPENAI_COMPAT_API_KEY: "PRIVATE_KEY" });
      throw new Error("没有拒绝非法 URL");
    } catch (error) {
      expect(String(error)).toContain("OPENAI_COMPAT_BASE_URL");
      expect(String(error)).not.toContain("PRIVATE_KEY");
    }
  }
  expect(() => modelConfigFromEnv({ MODEL_PROVIDER: "unknown" })).toThrow("MODEL_PROVIDER");
});

test("模型错误沿用旧 classifyModelError 的 code/retryable，落库 code 可重建同一语义", () => {
  const cases: [unknown, string, boolean][] = [
    [new ModelAuthError(), "model_auth", false], [new ModelHttpError(402), "model_quota", false],
    ...[401, 403].map((status): [unknown, string, boolean] => [new ModelHttpError(status), "model_auth", false]),
    ...[400, 422].map((status): [unknown, string, boolean] => [new ModelHttpError(status), "model_bad_request", false]),
    ...[408, 429, 500, 503].map((status): [unknown, string, boolean] => [new ModelHttpError(status), "model_error", true]),
    [new Error("model_input_budget:private"), "model_input_budget", false],
    [Object.assign(new Error(), { name: "ModelBudgetExceeded" }), "model_daily_budget", false],
    [{ lastError: new ModelAuthError() }, "model_auth", false], [new TypeError("ECONNREFUSED"), "model_error", true],
    [new ModelOutputError(), "model_error", true], [undefined, "model_error", true],
  ];
  for (const [error, code, retryable] of cases) {
    expect(classifyModelError(error)).toEqual({ code, retryable });
    expect(retryableModelCode(code)).toBe(retryable);
  }
});

test("最小团子提示词复用旧措辞，群聊逐行署名、单聊不混人，旧目标重答保留触发原话", () => {
  const names = (id: string) => id === "a" ? "甲" : id === "b" ? "乙" : undefined;
  const input = promptInput();
  const dm = buildChatPrompt(input, names);
  expect(dm.system).toContain("你外表有些高冷，内心十分细腻");
  expect(dm.system).toContain('你和 "甲" 的单聊');
  expect(dm.system).not.toContain("乙");
  expect(dm.messages).toEqual([{ role: "user", content: '"甲"：今天有点累\n"甲"：陪我坐一会儿' }]);
  const group = promptInput("group");
  const other = { ...group.trigger, id: "b-message", author: { kind: "member" as const, member_id: "b" }, text: "一起坐坐" };
  group.history.push(other); group.trigger = other;
  const built = buildChatPrompt(group, names);
  expect(built.system).toContain('群聊，成员为 "甲"、"乙"');
  expect(built.messages[1]).toEqual({ role: "user", content: '"乙"：一起坐坐' });
  expect(buildChatPrompt({ ...input, history: [] }, names).messages).toHaveLength(1);
  expect(() => buildChatPrompt({ ...input, history: [{ ...input.trigger, conversation_id: "other" }] }, names)).toThrow();
  expect(() => buildChatPrompt({ ...input, history: [{ ...input.trigger, author: other.author }] }, names)).toThrow();
  expect(buildChatPrompt(input, () => undefined).messages[0]!.content).toContain("已离开的成员");
});

test("ChatReplier 只发布正文，模型空响应留给 runner，错误包装不含供应商秘密", async () => {
  const client: ModelClient = { provider: "mock", modelId: "mock", async *stream() {
    yield { type: "reasoning-delta", delta: "内部推理" }; yield { type: "text-delta", delta: "喵" }; yield { type: "finish", finishReason: "stop" };
  } };
  expect(await collect(new ChatReplier(client, (input) => buildChatPrompt(input, () => "甲")).reply(promptInput()))).toEqual(["喵"]);
  const empty: ModelClient = { ...client, async *stream() { yield { type: "finish", finishReason: "stop" }; } };
  expect(await collect(new ChatReplier(empty, (input) => buildChatPrompt(input, () => "甲")).reply(promptInput()))).toEqual([]);
  const failed: ModelClient = { ...client, async *stream() { throw new ModelHttpError(402); } };
  await expect(collect(new ChatReplier(failed, (input) => buildChatPrompt(input, () => "甲")).reply(promptInput()))).rejects.toMatchObject({ code: "model_quota" });
  const missing: ModelClient = { ...client, async *stream() {} };
  await expect(collect(new ChatReplier(missing, (input) => buildChatPrompt(input, () => "甲")).reply(promptInput()))).rejects.toBeInstanceOf(ModelReplyError);
  const mock = createMockModel(1000);
  const abort = new AbortController();
  const pending = collect(new ChatReplier(mock, (input) => buildChatPrompt(input, () => "甲")).reply({ ...promptInput(), signal: abort.signal }));
  abort.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
});

function chunksResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) { controller.enqueue(new Uint8Array([byte])); }
    controller.close();
  } }));
}

test("自建兼容客户端处理 UTF-8/CRLF/多行 SSE/尾部 usage，思考不混入正文，请求参数正确", async () => {
  let wire: Record<string, any> = {};
  const client = createOpenAICompatible({ baseURL: "http://model/v1/", modelId: "deepseek-v4-test", apiKey: "PRIVATE_KEY", extraBody: { reasoning_effort: "none" },
    fetch: async (url, init) => {
      expect(url).toBe("http://model/v1/chat/completions");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer PRIVATE_KEY");
      wire = JSON.parse(String(init.body));
      return chunksResponse(': ping\r\ndata: {"choices":[{\r\ndata: "delta":{"reasoning_content":"思考","content":"喵😀"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":4}}\n\ndata: [DONE]');
    },
  });
  expect(await collect(client.stream({ system: "系统", messages: [{ role: "assistant", content: "之前" }, { role: "user", content: "你好" }] }))).toEqual([
    { type: "text-delta", delta: "喵😀" }, { type: "reasoning-delta", delta: "思考" }, { type: "finish", finishReason: "stop" },
  ]);
  expect(wire).toMatchObject({ model: "deepseek-v4-test", stream: true, stream_options: { include_usage: true }, reasoning_effort: "none", messages: [{ role: "system", content: "系统" }, { role: "assistant", content: "之前", reasoning_content: "" }, { role: "user", content: "你好" }] });
});

test("兼容客户端拒绝空流、坏 JSON、错误对象、截断和未经请求的工具；缺配置不发网络", async () => {
  for (const response of [new Response(null), chunksResponse("data: invalid\n\n"), chunksResponse('data: {"error":"PRIVATE_KEY"}\n\n'), chunksResponse('data: {"choices":[{"delta":{"content":7}}]}\n\n'), chunksResponse('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'), chunksResponse('data: {"choices":[{"delta":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]}\n\n')]) {
    const client = createOpenAICompatible({ baseURL: "http://model", modelId: "model", fetch: async () => response });
    await expect(collect(client.stream({ messages: [] }))).rejects.toBeInstanceOf(ModelOutputError);
  }
  let called = false;
  for (const client of [createDeepSeek({ modelId: "deepseek-flash", fetch: async () => { called = true; return new Response(); } }), createOpenAICompatible({ baseURL: "http://model", fetch: async () => { called = true; return new Response(); } })]) {
    await expect(collect(client.stream({ messages: [] }))).rejects.toBeInstanceOf(ModelAuthError);
  }
  expect(called).toBe(false);
  const failed = createOpenAICompatible({ baseURL: "http://model", modelId: "model", fetch: async () => new Response("PRIVATE_KEY", { status: 429 }) });
  try { await collect(failed.stream({ messages: [] })); throw new Error("expected error"); }
  catch (error) { expect(error).toBeInstanceOf(ModelHttpError); expect(String(error) + JSON.stringify(error)).not.toContain("PRIVATE_KEY"); }
});

test("真实模型 HTTP 请求流可取消并关闭响应体，DeepSeek 接口仍用自建客户端", async () => {
  let cancelled = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"喵"}}]}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }) });
  try {
    const abort = new AbortController();
    const client = createDeepSeek({ modelId: "deepseek-flash", baseURL: `http://127.0.0.1:${server.port}`, apiKey: "test", extraBody: { thinking: { type: "disabled" } } });
    const iterator = client.stream({ messages: [] }, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text-delta", delta: "喵" });
    const next = iterator.next(); abort.abort();
    await expect(next).rejects.toThrow();
    for (let i = 0; i < 100 && !cancelled; i += 1) { await Bun.sleep(1); }
    expect(cancelled).toBe(true);
  } finally { await server.stop(true); }
});
