import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../eval/cli.ts";
import { renderReport, summarizeResults, writeReport } from "../eval/report.ts";
import { loadCases, runCase, runCases } from "../eval/run.ts";
import { evalCaseSchema } from "../eval/schema.ts";
import { scoreCase } from "../eval/scorers.ts";
import { traceModel } from "../eval/trace.ts";
import type { ModelCallTrace } from "../eval/trace.ts";
import { judgeCase } from "../eval/judge.ts";
import { compareResults, compareRuns } from "../eval/compare.ts";

test("情侣套件走生产上下文全部通过，报告和 trace 可回放", async () => {
  const cases = await loadCases("chat-couple");
  const results = await runCases(cases, "scripted");
  expect(results.filter((item) => !item.passed)).toEqual([]);
  expect(results).toHaveLength(10);
  for (const result of results) {
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.text).toBe(result.reply);
    expect(result.trace[0]!.request.messages.at(-1)?.role).toBe("user");
    expect(result.latency_ms).toBeGreaterThanOrEqual(result.trace[0]!.latency_ms);
  }
  const group = results.find((item) => item.case_id === "group-history")!;
  const wire = JSON.stringify(group.trace[0]!.request.messages);
  expect(wire).toContain("院子野餐篮");
  expect(wire).toContain("蓝色野餐垫");
  expect(wire).not.toContain("私聊暗号琥珀");
  const direct = results.find((item) => item.case_id === "direct-isolation")!;
  expect(JSON.stringify(direct.trace)).not.toContain("秘密草莓蛋糕");
  const summary = summarizeResults(results);
  expect(summary.overall.pass_rate).toBe(1);
  expect(summary.by_tag["原话范围"]?.total).toBe(2);
  const directory = await mkdtemp(join(tmpdir(), "cattt-eval-"));
  try {
    await writeReport(results, directory);
    expect(JSON.parse(await readFile(join(directory, "summary.json"), "utf8"))).toEqual(summary);
    expect((await readFile(join(directory, "results.jsonl"), "utf8")).trim().split("\n")).toHaveLength(10);
    expect(await readFile(join(directory, "report.md"), "utf8")).toContain("## 失败用例\n\n无。");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("事项套件经持久作业执行并保留工具步骤，错误期望能触发失败", async () => {
  const cases = await loadCases("worker-errand");
  const results = await runCases(cases, "scripted");
  expect(results.filter((item) => !item.passed)).toEqual([]);
  expect(results).toHaveLength(4);
  expect(results[0]!.worker_steps?.at(-1)?.history.some((message) => message.role === "tool")).toBe(true);
  expect(results[0]!.trace[0]?.tool_response?.calls[0]?.name).toBe("get_time");
  const bad = structuredClone(cases[0]!);
  bad.expect.tool_calls = ["report", "get_time"];
  bad.expect.report_status = "blocked";
  bad.expect.max_steps = 1;
  const result = await runCase(bad, "scripted");
  expect(result.passed).toBe(false);
  expect(result.scores.filter((score) => !score.passed).map((score) => score.scorer)).toEqual(["tool_calls", "report_status", "max_steps"]);
}, 20000);

test("裁判严格解析、逐标准评分，坏 JSON 和矛盾分数均失败", async () => {
  const item = structuredClone((await loadCases("chat-couple"))[0]!);
  item.expect.judge = ["归属准确", "温暖自然"];
  for (const raw of ['{"score":5,"passed":true,"reason":"符合"}', 'not json', '{"score":2,"passed":true,"reason":"矛盾"}', '{"score":2,"passed":false,"reason":"不符合"}']) {
    const trace: ModelCallTrace[] = [];
    const scores = await judgeCase(item, "回复", trace, { provider: "mock", modelId: "judge-fixture", async *stream(request) {
      expect(request.extraBody?.temperature).toBe(0);
      yield { type: "text-delta", delta: raw }; yield { type: "finish", finishReason: "stop" };
    } });
    expect(scores).toHaveLength(2);
    expect(scores.every((score) => score.passed)).toBe(raw.includes('"score":5'));
    expect(trace.every((call) => call.purpose === "judge")).toBe(true);
    if (raw === "not json") expect(scores.every((score) => !!score.error)).toBe(true);
  }
});

test("对比列出退步、修复和新增缺失，门禁按允许下降比例执行", async () => {
  const result = await runCase((await loadCases("chat-couple"))[0]!, "scripted");
  const baseline = [result, { ...result, case_id: "fixed", passed: false }, { ...result, case_id: "missing" }];
  const candidate = [{ ...result, passed: false }, { ...result, case_id: "fixed" }, { ...result, case_id: "new" }];
  const comparison = compareResults(baseline, candidate, ["pass_rate=0.05", "suite:chat-couple=0"]);
  expect(comparison.regressed).toEqual([result.case_id]);
  expect(comparison.fixed).toEqual(["fixed"]);
  expect(comparison.new_cases).toEqual(["new"]);
  expect(comparison.missing_cases).toEqual(["missing"]);
  expect(comparison.passed).toBe(true);
  expect(compareResults([result], [{ ...result, passed: false }], ["pass_rate=0.05"]).passed).toBe(false);
  expect(compareResults([], [], ["pass_rate=0"]).passed).toBe(false);
  expect(() => compareResults([result, result], [])).toThrow("重复");
  const root = await mkdtemp(join(tmpdir(), "cattt-compare-"));
  try {
    await writeReport([result], join(root, "base"));
    await writeReport([{ ...result, passed: false }], join(root, "candidate"));
    expect(await compareRuns(join(root, "base"), join(root, "candidate/results.jsonl"), ["pass_rate=0"])).toBe(1);
    expect(await readFile(join(root, "candidate/compare.md"), "utf8")).toContain("退步用例");
    expect(JSON.parse(await readFile(join(root, "candidate/compare.json"), "utf8")).passed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("坏回复与撤回泄露期望均可触发失败，而非空断言假通过", async () => {
  const cases = await loadCases("chat-couple");
  const badReply = structuredClone(cases.find((item) => item.id === "cat-persona")!);
  badReply.scripted = "AI助手建议你打卡";
  const result = await runCase(badReply, "scripted");
  expect(result.passed).toBe(false);
  expect(result.scores.filter((score) => !score.passed).map((score) => score.scorer)).toContain("reply_contains");
  expect(renderReport([result])).toContain("reply_not_contains");
  const withdrawn = structuredClone(cases.find((item) => item.id === "withdrawn-memory")!);
  withdrawn.expect.context_includes = ["芝麻饼"];
  expect((await runCase(withdrawn, "scripted")).passed).toBe(false);
  const trace: ModelCallTrace[] = [{ provider: "mock", model: "test", latency_ms: 0, text: "",
    request: { system: "泄露芝麻饼", messages: [] } }];
  const empty = evalCaseSchema.parse({ ...withdrawn, expect: {} }).expect;
  expect(scoreCase(empty, "", [], 0)).toEqual([]);
  expect(scoreCase({ ...empty, context_excludes: ["芝麻饼"] }, "", trace, 0)[0]?.passed).toBe(false);
  expect(scoreCase({ ...empty, context_excludes: ["芝麻饼"] }, "", [], 0)[0]?.passed).toBe(false);
  expect(scoreCase({ ...empty, max_latency_ms: 1, reply_regex: ["猫"], reply_contains: ["猫"], reply_not_contains: ["助手"] }, "助手", [], 2).every((score) => !score.passed)).toBe(true);
});

test("缺脚本与模型错误保留失败和 trace，schema 拒绝坏引用/正则", async () => {
  const item = structuredClone((await loadCases("chat-couple"))[0]!);
  delete item.scripted;
  const result = await runCase(item, "scripted");
  expect(result.passed).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.trace[0]?.error).toContain("缺少 scripted");
  expect(evalCaseSchema.safeParse({ ...item, input: { sender: "nobody", text: "你好" } }).success).toBe(false);
  expect(evalCaseSchema.safeParse({ ...item, expect: { reply_regex: ["["] } }).success).toBe(false);
  const trace: ModelCallTrace[] = [];
  const client = traceModel({ provider: "test", modelId: "broken", async *stream() {
    yield { type: "text-delta", delta: "部分" };
    throw new Error("测试模型失败");
  } }, trace);
  await expect((async () => { for await (const _ of client.stream({ messages: [] })) {} })()).rejects.toThrow("测试模型失败");
  expect(trace[0]?.text).toBe("部分");
  expect(trace[0]?.error).toContain("测试模型失败");
});

test("空集合无虚构通过率，CLI 拒绝空选择和错误参数", async () => {
  expect(summarizeResults([]).overall).toMatchObject({ total: 0, pass_rate: null, p95_latency_ms: null });
  expect(renderReport([])).toContain("通过 0 / 0");
  await expect(main(["run", "--suite", "chat-couple", "--mode", "scripted", "--case", "missing"])).rejects.toThrow("未找到");
  await expect(main(["run", "--suite", "../bad", "--mode", "scripted"])).rejects.toThrow("套件名");
  await expect(main(["run", "--mode", "bad"])).rejects.toThrow("用法");
});
