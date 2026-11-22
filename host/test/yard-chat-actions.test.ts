import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { worldActions } from "../src/store/schema/world.ts";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = performance.now() + 12_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error(JSON.stringify(value));
    await Bun.sleep(35);
  }
}

class TestClock extends SystemClock {
  offset = 0;
  override wallMs() { return super.wallMs() + this.offset; }
}

const observation = {
  state_version: 0, scene_version: 4, destination_ids: ["house", "tree", "bed", "grass", "pond", "fence"],
  current_destination_id: "house", target_destination_id: "house", phase: "idle", action: "sit_idle",
  paused: false, runnable: true, companion_seat: "house",
};

type ModelRequest = {
  stream: boolean; tool_choice?: string;
  messages: { role: string; content: string; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};

function toolCall(id: string, name: string, args = {}) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function actionReply(...calls: ReturnType<typeof toolCall>[]) {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
    content: "我已经到达并坐稳了。", reasoning_content: "测试推理不应进入 SSE。", tool_calls: calls,
  } }], usage: { prompt_tokens: 120, completion_tokens: 24 } });
}

test("共享院子聊天经双 SQLite、HTTPS、mTLS 和测试 3D 执行器，只使用已验证的当前会话和实际回执", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-yard-chat-"));
  const stops: (() => Promise<void>)[] = [];
  const errors: unknown[] = [];
  const requests: ModelRequest[] = [];
  const commands: { id: string; destination_id: string; activity?: string }[] = [];
  let calls = 0;
  let intercept: ((body: ModelRequest, tool: string) => Promise<Response | undefined>) | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBeNull();
    const body = await request.json() as ModelRequest;
    requests.push(body);
    if (body.stream) return new Response([
      'data: {"choices":[{"delta":{"content":"我在听。"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]', '',
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    expect(body.tool_choice).toBe("auto");
    const names = body.tools!.map(({ function: fn }) => fn.name);
    const observed = body.messages.some((item) => item.role === "tool");
    const name = observed && names.includes("move_cat") ? "move_cat"
      : observed && names.includes("sit_together") ? "sit_together" : names[0]!;
    return await intercept?.(body, name)
      ?? actionReply(toolCall(`call-${++calls}`, name, name === "move_cat" ? { destination_id: "pond" } : {}));
  } });
  const config = modelConfigFromEnv({
    MODEL_PROVIDER: "deepseek", CHAT_PROVIDER: "openai-compatible", CHAT_MODEL: "deepseek-v4-yard-fixture",
    OPENAI_COMPAT_BASE_URL: new URL("/v1", model.url).href,
  });

  async function launch(name: string) {
    const dir = join(root, name);
    const gateway = new Gateway({ peerPort: 0, peerHostname: "127.0.0.1", lanPort: 0 });
    const clock = new TestClock(crypto.randomUUID());
    const host = await startConfiguredHost({ dataDir: dir, port: 0, clock, model: config,
      onError: (error) => { errors.push(error); },
    }, gateway);
    stops.push(host.stop);
    const ca = readFileSync(join(dir, "tls/ca.crt"), "utf8");
    const admin = readFileSync(join(dir, "host-admin.token"), "utf8").trim();
    function request(path: string, method = "GET", body?: unknown, token?: string, signal?: AbortSignal, phone = token !== undefined) {
      const origin = phone ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`;
      return fetch(origin + path, { method, tls: { ca }, signal: signal ?? AbortSignal.timeout(10_000),
        headers: { ...(phone && !token ? {} : { authorization: `Bearer ${token ?? admin}` }), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function call(path: string, method?: string, body?: unknown, token?: string, phone?: boolean) {
      const response = await request(path, method, body, token, undefined, phone);
      return { status: response.status, body: await response.json() };
    }
    return { host, clock, request, call };
  }

  let connection = new AbortController();
  let executor: Promise<void> | undefined;
  try {
    const a = await launch("a");
    const b = await launch("b");
    const member = (await a.call("/host/members", "POST", { display_name: "甲" })).body.member;
    async function pair() {
      const code = (await a.call("/host/pairing-codes", "POST", { member_id: member.id })).body.code;
      return (await a.call("/v2/pair", "POST", { code, device_name: "甲手机" }, undefined, true)).body.device_token as string;
    }
    const alice = await pair();
    const secondDevice = await pair();
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
    const bob = joined.body.device_token;
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");

    const wa = (path: string, method?: string, body?: unknown) => a.call(`/v2/world/${path}`, method, body, alice);
    const registration = await wa("sessions", "POST", { protocol_version: 2 });
    const { session_id, generation } = registration.body;
    let session = { session_id, generation };
    let snapshot = observation;
    const refresh = () => wa("state").then(({ body }) => wa("state", "PUT", {
      ...session, base_revision: body.world.revision, snapshot,
    }));
    expect(await refresh()).toMatchObject({ status: 200 });
    let finish = false;
    let accept = true;
    let running = false;
    const seen = new Set<string>();
    let worldError: string | undefined;
    let streamEnded = true;
    async function connectExecutor() {
      connection.abort();
      await executor;
      connection = new AbortController();
      const signal = connection.signal;
      streamEnded = false;
      const stream = await a.request(`/v2/world/events?${new URLSearchParams(session)}`, "GET", undefined, alice, signal);
      executor = (async () => {
        const reader = stream.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (!signal.aborted) {
            const result = await reader.read();
            if (result.done) return;
            pending += decoder.decode(result.value, { stream: true });
            for (let boundary = pending.indexOf("\n\n"); boundary >= 0; boundary = pending.indexOf("\n\n")) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              if (frame.includes("event: world_error\n")) worldError = frame;
              if (!frame.includes("event: action\n")) continue;
              const action = JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
              if (seen.has(action.id)) continue;
              seen.add(action.id);
              commands.push(action);
              if (!accept) continue;
              const ack = (status: string, extra = {}) => wa(`actions/${action.id}/ack`, "POST", { ...session, status, snapshot, ...extra });
              expect((await ack("accepted")).body.status).toBe("accepted");
              if (running) {
                const moving = { ...snapshot, state_version: snapshot.state_version + 1, phase: "moving",
                  target_destination_id: action.destination_id, action: "walk" };
                expect(await ack("running", { snapshot: moving })).toMatchObject({ status: 200, body: { status: "running" } });
                snapshot = moving;
              }
              if (finish) {
                const destination = action.destination_id;
                if (action.activity === "sit") {
                  const fallback = { ...snapshot, state_version: snapshot.state_version + 1,
                    current_destination_id: destination, target_destination_id: destination, activity: "sit", activity_fallback: true };
                  expect((await ack("arrived", { snapshot: fallback })).body.error.code).toBe("arrival_not_observed");
                }
                snapshot = { ...snapshot, state_version: snapshot.state_version + 1,
                  current_destination_id: destination, target_destination_id: destination,
                  ...(action.activity === "sit" && { activity: "sit", activity_fallback: false }) };
                expect((await ack("arrived")).body.status).toBe("arrived");
              }
            }
          }
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally { await reader.cancel().catch(() => {}); }
      })();
      void executor.finally(() => { streamEnded = true; }).catch(() => {});
    }
    async function prepareAction() {
      await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");
      const saved = await refresh();
      expect(saved).toMatchObject({ status: 200 });
      if (streamEnded || !saved.body.execution_available) await connectExecutor();
      await until(() => wa("state"), ({ body }) => body.execution_available);
    }
    await prepareAction();
    const direct = async (node: typeof a, token: string) => (await node.call("/v2/conversations", "GET", undefined, token))
      .body.conversations.find(({ kind }: { kind: string }) => kind === "direct").id;
    const conversation = `/v2/conversations/${await direct(a, alice)}`;
    const send = (text: string, id = crypto.randomUUID(), node = a, token = alice, base = conversation) =>
      node.call(`${base}/messages`, "POST", { text, client_message_id: id }, token);
    async function reply(url: string, node = a, token = alice) {
      const response = await node.request(url, "GET", undefined, token);
      expect(response.status).toBe(200);
      const frames = await response.text();
      const text = [...frames.matchAll(/^event: delta\ndata: (.*)$/gm)].map((match) => JSON.parse(match[1]!).text).join("");
      return { frames, text };
    }

    const ordinary = await send("我想跟你说说话，不要去池塘。");
    expect((await reply(ordinary.body.turn.stream_url)).text).toBe("我在听。");
    expect(requests.map(({ stream }) => stream)).toEqual([true]);
    expect(commands).toHaveLength(0);

    const read = await send("团子现在在哪里？");
    expect((await reply(read.body.turn.stream_url)).text).toContain("蘑菇屋");
    expect(commands).toHaveLength(0);

    const wrongDevice = await send("去池塘", crypto.randomUUID(), a, secondDevice);
    expect((await reply(wrongDevice.body.turn.stream_url, a, secondDevice)).text).toContain("没确认");
    const remoteBase = `/v2/conversations/${await direct(b, bob)}`;
    const remote = await send("去池塘", crypto.randomUUID(), b, bob, remoteBase);
    expect((await reply(remote.body.turn.stream_url, b, bob)).text).toContain("没确认");
    expect(commands).toHaveLength(0);

    await prepareAction();
    const key = crypto.randomUUID();
    running = true;
    const move = await send("团子，去池塘", key);
    const first = await reply(move.body.turn.stream_url);
    expect(first.text, JSON.stringify({
      worldError, commands, turns: a.host.store.db.select().from(worldActions).all().map(({ status, reason }) => ({ status, reason })),
      lastTools: requests.slice(-2).map(({ tools, messages }) => ({
        tools: tools?.map(({ function: fn }) => fn.name),
        observations: messages.filter(({ role }) => role === "tool").map(({ content }) => content),
      })),
    })).toContain("接到");
    expect(first.text).not.toContain("已经到达");
    expect(first.frames).not.toContain("测试推理");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ destination_id: "pond", request_id: move.body.message.id, ...session });
    const writeRequest = requests.find(({ messages }) => messages.some((message) => message.role === "tool"))!;
    const toolMessage = writeRequest.messages.find(({ role }) => role === "tool")!;
    expect(JSON.parse(toolMessage.content)).toMatchObject({ status: "succeeded" });
    expect(toolMessage.tool_call_id).toBeDefined();
    expect(writeRequest.messages.some((message) => "reasoning_content" in message
      && message.reasoning_content === "测试推理不应进入 SSE。")).toBe(true);

    await until(async () => snapshot.phase, (phase) => phase === "moving");
    const movingState = await send("你在哪儿？");
    expect((await reply(movingState.body.turn.stream_url)).text).toContain("在移动");
    const arrival = { ...snapshot, state_version: snapshot.state_version + 1, current_destination_id: "pond",
      target_destination_id: "pond", phase: "idle", action: "sit_idle" };
    expect((await wa(`actions/${commands[0]!.id}/ack`, "POST", { ...session, status: "arrived", snapshot: arrival })).body.status).toBe("arrived");
    snapshot = arrival;
    const replay = await send("团子，去池塘", key);
    expect(replay.body.turn.id).toBe(move.body.turn.id);
    expect((await reply(replay.body.turn.stream_url)).text).toBe(first.text);
    const retry = await a.call(`${conversation}/messages/${move.body.message.id}/reply`, "POST", { request_id: crypto.randomUUID() }, alice);
    expect((await reply(retry.body.stream_url)).text).toContain("到了池塘");
    const status = await send("到了吗？");
    expect((await reply(status.body.turn.stream_url)).text).toContain("到了池塘");
    expect(commands).toHaveLength(1);

    await prepareAction();
    finish = true;
    running = false;
    const sit = await send("陪我坐一会儿");
    expect((await reply(sit.body.turn.stream_url)).text).toContain("坐稳");
    expect(commands[1]).toMatchObject({ activity: "sit", destination_id: "house" });
    const synced = await until(() => b.call("/v2/world/state", "GET", undefined, bob),
      ({ body }) => body.world?.snapshot?.activity_fallback === false);
    expect(synced.body.world.snapshot.current_destination_id).toBe("house");

    finish = false;
    accept = false;
    await prepareAction();
    const lostKey = crypto.randomUUID();
    const unknown = await send("去池塘", lostKey);
    const dropped = await a.request(unknown.body.turn.stream_url, "GET", undefined, alice);
    const disconnected = dropped.body!.getReader();
    const firstEvent = new TextDecoder().decode((await disconnected.read()).value);
    await disconnected.cancel();
    const cursor = firstEvent.match(/^id: (.+)$/m)?.[1];
    expect(cursor).toBeDefined();
    const after = await send("去池塘", lostKey);
    expect(after.body.turn.id).toBe(unknown.body.turn.id);
    const recovered = await a.request(`${after.body.turn.stream_url}?last_event_id=${cursor}`, "GET", undefined, alice);
    expect(await recovered.text()).toContain("没确认");
    const records = a.host.store.db.select().from(worldActions).all();
    expect(records.find(({ requestId }) => requestId === unknown.body.message.id), JSON.stringify({
      worldError, streamEnded, commands, records: records.map(({ status, reason }) => ({ status, reason })),
      modelCalls: requests.slice(-3).map(({ tools }) => tools?.map(({ function: fn }) => fn.name)),
    })).toBeDefined();
    await until(async () => commands.length, (count) => count === 3);
    expect((await wa(`actions/${commands[2]!.id}/ack`, "POST", { ...session, status: "rejected", snapshot })).body.status).toBe("rejected");

    await prepareAction();
    let malformed = false;
    intercept = async (_body, name) => {
      if (name !== "move_cat" || malformed) return;
      malformed = true;
      return actionReply(toolCall(`bad-${++calls}`, "move_cat", { destination_id: "tree" }),
        toolCall(`good-${++calls}`, "move_cat", { destination_id: "pond" }));
    };
    accept = true;
    finish = true;
    const groupId = (await a.call("/v2/conversations", "GET", undefined, alice)).body.conversations
      .find(({ kind }: { kind: string }) => kind === "group").id;
    const group = await send("团子，去池塘", crypto.randomUUID(), a, alice, `/v2/conversations/${groupId}`);
    const groupReply = await reply(group.body.turn.stream_url);
    expect(groupReply.text).toMatch(/到了池塘|接到/);
    const groupReceipt = await until(() => wa(`actions/${commands[3]!.id}`), ({ body }) => body.status === "arrived");
    expect(groupReceipt.body.destination_id).toBe("pond");
    expect(malformed).toBe(true);
    expect(requests.some(({ messages }) => messages.some(({ role, content }) =>
      role === "tool" && content.includes("tool_batch_rejected")))).toBe(true);
    expect(commands).toHaveLength(4);

    let planned!: () => void;
    let resume!: () => void;
    async function blockDispatch() {
      const entered = new Promise<void>((resolve) => { planned = resolve; });
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      intercept = async (_body, name) => {
        if (name !== "move_cat") return;
        planned();
        await gate;
        return actionReply(toolCall(`blocked-${++calls}`, "move_cat", { destination_id: "pond" }));
      };
      await prepareAction();
      const sent = await send("去池塘");
      await Promise.race([entered, Bun.sleep(10_000).then(() => { throw new Error("未进入移动工具"); })]);
      return sent;
    }
    const cancelled = await blockDispatch();
    expect((await a.call(`${conversation}/turns/${cancelled.body.turn.id}/cancel`, "POST", {}, alice)).status).toBe(200);
    resume();
    expect((await reply(cancelled.body.turn.stream_url)).frames).toContain("event: done");
    const cancelledRetry = await a.call(`${conversation}/messages/${cancelled.body.message.id}/reply`, "POST", { request_id: crypto.randomUUID() }, alice);
    expect((await reply(cancelledRetry.body.stream_url)).text).toContain("没确认");
    expect(commands).toHaveLength(4);

    const replaced = await blockDispatch();
    const newSession = await wa("sessions", "POST", { protocol_version: 2 });
    expect(newSession.status).toBe(200);
    expect(newSession.body.generation).not.toBe(session.generation);
    resume();
    expect((await reply(replaced.body.turn.stream_url)).text).toContain("没确认");
    session = { session_id: newSession.body.session_id, generation: newSession.body.generation };
    await connectExecutor();

    const expired = await blockDispatch();
    a.clock.offset = 2600;
    resume();
    expect((await reply(expired.body.turn.stream_url)).text).toContain("没确认");
    expect(commands).toHaveLength(4);
    expect(a.host.store.db.select().from(worldActions).all()).toHaveLength(4);
    expect(errors).toEqual([]);
  } finally {
    connection.abort();
    model.stop(true);
    try { await executor; }
    finally {
      await Promise.all(stops.reverse().map((stop) => stop()));
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 90_000);
