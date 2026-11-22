import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { diaryModelRequest } from "../src/soul/diary-writer.ts";
import { scanCatDiary } from "../src/store/cat-diary.ts";
import { jobs, modelCalls } from "../src/store/schema/index.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const midnight = Date.parse("2026-11-22T16:00:00Z");
const reflection = "心里有一点欢喜。";

test("少量审核卡按原输入顺序全保留，感受继续由模型选择", () => {
  const { schema, extraBody } = diaryModelRequest({
    day: "2026-11-22", persona: "团子", facts: [{ id: "world", text: "小院事实" }, { id: "diary", text: "已许可原话" }],
  });
  expect(schema.safeParse({ feeling: "温暖", fact_ids: [1, 2] }).success).toBe(true);
  expect(schema.safeParse({ feeling: "平静", fact_ids: [2, 1] }).success).toBe(false);
  expect(schema.safeParse({ feeling: "平静", fact_ids: [1] }).success).toBe(false);
  expect(extraBody.response_format.json_schema.schema.properties?.fact_ids).toEqual({ const: [1, 2] });
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function eventually<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error("等待日记作业状态超时");
    await Bun.sleep(20);
  }
}

async function fixture(config: Record<string, string>, diaryOutput: Record<string, unknown> = { feeling: "欢喜" }) {
  const root = mkdtempSync(join(tmpdir(), "cattt-diary-admission-"));
  const active = gate();
  const wire: { model: string; messages: { content: string }[]; max_tokens: number; response_format?: unknown }[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as typeof wire[number];
      wire.push(body);
      if (wire.length === 1) await active.wait;
      const facts = body.model === "diary-fixture" ? JSON.parse(body.messages.at(-1)!.content).facts : [];
      const content = JSON.stringify({ fact_ids: facts.map(({ id }: { id: number }) => id), ...diaryOutput });
      const chunk = { choices: [{ delta: { content }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    },
  });
  const clock = new ManualClock("diary-admission", midnight - 60_000);
  const gateway = new Gateway();
  const host = await startConfiguredHost({
    dataDir: root, port: 0, clock, model: modelConfigFromEnv({
      MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: new URL("/fixture", endpoint.url).href,
      CHAT_MODEL: "foreground-fixture", EXTRACT_MODEL: "diary-fixture", ...config,
    }),
  }, gateway);
  const { token } = issueTestDevice(host, "甲");
  async function call(path: string, method = "GET", body?: object) {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v2${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(response.status).toBe(200 + (method === "POST" && path === "/diary" ? 1 : 0));
    return response.json();
  }
  function foreground() {
    return Array.fromAsync(host.models.text("chat").stream({
      messages: [{ role: "user", content: "前台测试" }], maxOutputTokens: 16,
    })).then(() => undefined);
  }
  function due(at = midnight + 5 * 60_000) {
    clock.setWallMs(at);
    scanCatDiary(host);
  }
  scanCatDiary(host);
  return {
    active, wire, host, clock, call, foreground, due,
    ledger: () => host.store.db.select().from(modelCalls).all(),
    diaryJobs: () => host.store.db.select().from(jobs).where(eq(jobs.queue, "daily-cat-diary")).all(),
    entries: async () => (await call("/cat-diary")).entries as { text: string; writer: { provider: string } }[],
    async stop() {
      active.release();
      await host.stop();
      await endpoint.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("猫日记与前台共享 UTC 日账本，日额度用完出模板，次日用 extract 恢复", async () => {
  const f = await fixture({ MODEL_DAILY_CALL_LIMIT: "1" });
  try {
    f.active.release();
    await f.foreground();
    f.due();
    const first = await eventually(f.entries, (rows) => rows.length === 1);
    expect(first[0]!.writer.provider).toBe("fallback");
    expect(f.wire.map(({ model }) => model)).toEqual(["foreground-fixture"]);
    expect(f.ledger()).toMatchObject([{ day: "2026-11-22", slot: "chat", purpose: "chat" }]);

    f.due(midnight + 86_400_000 + 5 * 60_000);
    const second = await eventually(f.entries, (rows) => rows.length === 2);
    expect(second[1]).toMatchObject({ writer: { provider: "local" }, text: reflection });
    expect(f.wire.map(({ model }) => model)).toEqual(["foreground-fixture", "diary-fixture"]);
    expect(f.wire[1]!.max_tokens).toBe(1600);
    expect(f.wire[1]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "cat_diary", strict: true, schema: { additionalProperties: false } },
    });
    expect(f.ledger()).toMatchObject([
      { day: "2026-11-22", slot: "chat", purpose: "chat" },
      { day: "2026-11-23", slot: "extract", purpose: "cat_diary", status: "completed" },
    ]);
  } finally { await f.stop(); }
}, 60_000);

test("猫日记等待同一模型槽位时撤回来源，前台先用空位，重新读取后才调用", async () => {
  const f = await fixture({});
  try {
    const text = "待撤回的独有日记片段";
    const { entry } = await f.call("/diary", "POST", {
      request_id: crypto.randomUUID(), text, recorded_at: f.clock.wallMs(),
      local_day: "2026-11-22", time_zone: "Asia/Shanghai", cat_allowed: true,
    });
    await f.call("/cat-diary/sources", "POST", { kind: "diary", id: entry.id, revision: entry.revision });
    const running = f.foreground();
    await eventually(() => f.wire.length, (count) => count === 1);
    f.due();
    await eventually(f.diaryJobs, (rows) => rows[0]?.status === "running");
    const queued = f.foreground();
    await f.call(`/diary/${entry.id}/cat-allowed`, "PATCH", {
      request_id: crypto.randomUUID(), expected_revision: entry.revision, cat_allowed: false,
    });
    expect(f.wire).toHaveLength(1);
    f.active.release();
    await Promise.all([running, queued]);
    await eventually(f.diaryJobs, (rows) => rows[0]?.status === "queued" && rows[0].runAt > f.clock.wallMs());
    expect(f.ledger().map(({ purpose }) => purpose)).toEqual(["chat", "chat"]);
    f.clock.advance(1_000);
    scanCatDiary(f.host);
    const rows = await eventually(f.entries, (entries) => entries.length === 1);
    expect(rows[0]!.text).toBe(reflection);
    expect(f.wire.map(({ model }) => model)).toEqual(["foreground-fixture", "foreground-fixture", "diary-fixture"]);
    expect(JSON.stringify(f.wire)).not.toContain(text);
  } finally { await f.stop(); }
}, 60_000);

test("本机模型只选择感受，带审核卡片编号的自由经历仍退回未引用的日记", async () => {
  const f = await fixture({}, { reflection: "听见铃铛响了，我很满足。" });
  try {
    const text = "给旧收音机换了电池";
    const { entry } = await f.call("/diary", "POST", {
      request_id: crypto.randomUUID(), text, recorded_at: f.clock.wallMs(),
      local_day: "2026-11-22", time_zone: "Asia/Shanghai", cat_allowed: true,
    });
    const confirmed = await f.call("/cat-diary/sources", "POST", { kind: "diary", id: entry.id, revision: entry.revision });
    f.active.release();
    f.due();
    const rows = await eventually(f.entries, (entries) => entries.length === 1);
    expect(JSON.parse(f.wire[0]!.messages.at(-1)!.content).facts).toEqual([
      { id: 1, text: `甲留下一句话：「${text}」` },
    ]);
    expect(typeof confirmed.id).toBe("string");
    expect(rows[0]).toMatchObject({ writer: { provider: "fallback" }, sources: [] });
    expect(f.wire).toHaveLength(1);
    expect(f.ledger()).toMatchObject([{ slot: "extract", purpose: "cat_diary", status: "completed" }]);
  } finally { await f.stop(); }
}, 60_000);

test("本机模型回传短编号，日记引用保留原审核卡片 ID", async () => {
  const f = await fixture({}, { feeling: "欢喜", fact_ids: [1] });
  try {
    const text = "换好了坏掉的唱针";
    const { entry } = await f.call("/diary", "POST", {
      request_id: crypto.randomUUID(), text, recorded_at: f.clock.wallMs(),
      local_day: "2026-11-22", time_zone: "Asia/Shanghai", cat_allowed: true,
    });
    const { id } = await f.call("/cat-diary/sources", "POST", { kind: "diary", id: entry.id, revision: entry.revision });
    f.active.release();
    f.due();
    const rows = await eventually(f.entries, (entries) => entries.length === 1);
    expect(rows[0]).toMatchObject({
      writer: { provider: "local" },
      text: `甲留下一句话：「${text}」\n${reflection}`,
      sources: [{ kind: "diary", id }],
    });
  } finally { await f.stop(); }
}, 60_000);

test("显式云 extract 缺本机日记槽位，作业待恢复且不派发事实或发布模板", async () => {
  const f = await fixture({ EXTRACT_PROVIDER: "deepseek", MAOMAO_DEEPSEEK_BASE_URL: "http://127.0.0.1:9" });
  try {
    f.due();
    await eventually(f.diaryJobs, (rows) => rows[0]?.status === "queued" && rows[0].runAt > f.clock.wallMs());
    expect(f.wire).toEqual([]);
    expect(f.ledger()).toEqual([]);
    expect(await f.entries()).toEqual([]);
  } finally { await f.stop(); }
}, 60_000);
