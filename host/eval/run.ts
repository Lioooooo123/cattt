import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { evalCaseSchema } from "./schema.ts";
import type { EvalCase, EvalMode } from "./schema.ts";
import { scoreCase } from "./scorers.ts";
import type { Score } from "./scorers.ts";
import { runChat } from "./targets/chat.ts";
import { runWorker } from "./targets/worker.ts";
import { judgeCase } from "./judge.ts";
import type { ModelCallTrace, WorkerStepTrace } from "./trace.ts";
import type { WorkerResult } from "../src/ticket-workers/types.ts";

export interface EvalResult {
  case_id: string; suite: string; target: "chat" | "worker"; tags: string[]; mode: EvalMode;
  provider: string; model: string; passed: boolean; scores: Score[];
  reply: string; latency_ms: number; trace: ModelCallTrace[]; error?: string;
  judge_mode?: "none" | "env"; judge_latency_ms?: number; worker_steps?: WorkerStepTrace[]; report?: WorkerResult;
}
export async function loadCases(suite: string, directory = join(import.meta.dir, "suites")): Promise<EvalCase[]> {
  if (suite !== "all" && !/^[a-zA-Z0-9_-]+$/.test(suite)) throw new Error("套件名只允许字母、数字、横线和下划线");
  const files = suite === "all" ? (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort() : [`${suite}.jsonl`];
  const cases: EvalCase[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const lines = (await Bun.file(join(directory, file)).text()).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const item = evalCaseSchema.parse(JSON.parse(line));
        if (item.suite !== file.slice(0, -6)) throw new Error("suite 与文件名不一致");
        if (ids.has(item.id)) throw new Error(`重复用例 ID：${item.id}`);
        ids.add(item.id); cases.push(item);
      } catch (error) { throw new Error(`${file}:${index + 1}：${String(error)}`); }
    }
  }
  if (!cases.length) throw new Error("套件没有用例");
  return cases;
}
export async function runCase(input: EvalCase, mode: EvalMode, judge: "none" | "env" = "none"): Promise<EvalResult> {
  const item = evalCaseSchema.parse(input);
  const result: EvalResult = { case_id: item.id, suite: item.suite, target: item.target, tags: item.tags,
    mode, provider: "unknown", model: "unknown", passed: false, scores: [], reply: "", latency_ms: 0, trace: [] };
  const start = performance.now();
  try {
    if (item.target === "chat") Object.assign(result, await runChat(item, mode, result.trace, (chunk) => { result.reply += chunk; }));
    else {
      result.worker_steps = [];
      Object.assign(result, await runWorker(item, mode, result.trace, result.worker_steps));
      result.reply = result.report ? JSON.stringify(result.report) : "";
    }
  } catch (error) { result.error = String(error); }
  result.latency_ms = performance.now() - start;
  result.provider = result.trace[0]?.provider ?? result.provider;
  result.model = result.trace[0]?.model ?? result.model;
  result.scores = scoreCase(item.expect, result.reply, result.trace, result.latency_ms);
  if (item.target === "worker") {
    const names = (result.worker_steps?.at(-1)?.history ?? []).flatMap((message) => message.role === "tool" ? message.observations.map((observation) => observation.name) : []);
    if (item.expect.tool_calls.length) {
      let index = 0;
      for (const name of names) if (name === item.expect.tool_calls[index]) index++;
      result.scores.push({ scorer: "tool_calls", passed: index === item.expect.tool_calls.length, detail: `期望有序子序列 ${JSON.stringify(item.expect.tool_calls)}；实际 ${JSON.stringify(names)}` });
    }
    if (item.expect.report_status) result.scores.push({ scorer: "report_status", passed: result.report?.status === item.expect.report_status, detail: `期望 ${item.expect.report_status}；实际 ${result.report?.status ?? "无报告"}` });
    if (item.expect.report_contains.length) {
      const report = result.report ? JSON.stringify(result.report) : "";
      const missing = item.expect.report_contains.filter((text) => !report.includes(text));
      result.scores.push({ scorer: "report_contains", passed: !missing.length, detail: missing.length ? `缺少 ${JSON.stringify(missing)}` : "报告关键词齐全" });
    }
    if (item.expect.max_steps !== undefined) result.scores.push({ scorer: "max_steps", passed: !!result.report && (result.worker_steps?.length ?? 0) <= item.expect.max_steps, detail: `${result.worker_steps?.length ?? 0} / ${item.expect.max_steps}` });
  }
  result.judge_mode = judge;
  if (judge === "env" && !result.error) {
    const judgeStart = performance.now();
    result.scores.push(...await judgeCase(item, result.reply, result.trace));
    result.judge_latency_ms = performance.now() - judgeStart;
  }
  result.passed = !result.error && result.scores.every((score) => score.passed);
  return result;
}
export async function runCases(cases: readonly EvalCase[], mode: EvalMode, judge: "none" | "env" = "none"): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const item of cases) results.push(await runCase(item, mode, judge));
  return results;
}
