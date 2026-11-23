import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { summarizeResults } from "./report.ts";
import type { EvalResult } from "./run.ts";

const rowSchema = z.object({ case_id: z.string().min(1), suite: z.string().min(1), passed: z.boolean(),
  latency_ms: z.number().nonnegative(), tags: z.array(z.string()), provider: z.string(), model: z.string(), mode: z.enum(["scripted", "env"]) });
export function compareResults(baseline: readonly EvalResult[], candidate: readonly EvalResult[], gates: string[] = []) {
  const index = (rows: readonly EvalResult[]) => {
    const map = new Map<string, EvalResult>();
    for (const row of rows) { if (map.has(row.case_id)) throw new Error(`重复用例：${row.case_id}`); map.set(row.case_id, row); }
    return map;
  };
  const before = index(baseline), after = index(candidate);
  const base = summarizeResults(baseline), next = summarizeResults(candidate);
  const delta = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : b - a;
  const suites = [...new Set([...Object.keys(base.by_suite), ...Object.keys(next.by_suite)])].sort();
  const overall = { baseline: base.overall.pass_rate, candidate: next.overall.pass_rate, delta: delta(base.overall.pass_rate, next.overall.pass_rate) };
  const by_suite = Object.fromEntries(suites.map((suite) => [suite, { baseline: base.by_suite[suite]?.pass_rate ?? null,
    candidate: next.by_suite[suite]?.pass_rate ?? null, delta: delta(base.by_suite[suite]?.pass_rate, next.by_suite[suite]?.pass_rate) }]));
  const regressed = candidate.filter((row) => !row.passed && before.get(row.case_id)?.passed).map((row) => row.case_id);
  const fixed = candidate.filter((row) => row.passed && before.get(row.case_id)?.passed === false).map((row) => row.case_id);
  const added = candidate.filter((row) => !before.has(row.case_id)).map((row) => row.case_id);
  const missing = baseline.filter((row) => !after.has(row.case_id)).map((row) => row.case_id);
  const gate_results = gates.map((gate) => {
    const parsed = /^(pass_rate|suite:[a-zA-Z0-9_-]+)=(\d+(?:\.\d+)?)$/.exec(gate);
    if (!parsed || Number(parsed[2]) > 1) throw new Error(`无效门禁：${gate}`);
    const value = parsed[1] === "pass_rate" ? overall : by_suite[parsed[1]!.slice(6)];
    return { gate, passed: value?.delta != null && value.delta >= -Number(parsed[2]) - 1e-12 };
  });
  return { overall, by_suite, regressed, fixed, new_cases: added, missing_cases: missing, gate_results,
    passed: gate_results.every((gate) => gate.passed) };
}
export function renderComparison(result: ReturnType<typeof compareResults>) {
  const rate = (value: number | null) => value === null ? "—" : `${(100 * value).toFixed(1)}%`;
  return ["# 团子评测对比", "", "通过率差值为候选减基线；套件新增/缺失没有可比差值。用例变化会影响总体分母，scripted 与真实模型不是等价质量基准。", "",
    "| 范围 | 基线 | 候选 | 差值 |", "| --- | --- | --- | --- |",
    ...[["总体", result.overall] as const, ...Object.entries(result.by_suite)].map(([name, value]) => `| ${name} | ${rate(value.baseline)} | ${rate(value.candidate)} | ${rate(value.delta)} |`), "",
    `退步用例（通过→失败）：${result.regressed.join("、") || "无"}`, `修复用例：${result.fixed.join("、") || "无"}`,
    `新增用例：${result.new_cases.join("、") || "无"}`, `缺失用例：${result.missing_cases.join("、") || "无"}`, "", "## 门禁", "",
    ...result.gate_results.map((gate) => `- ${gate.gate}：${gate.passed ? "通过" : "失败（含不可比较）"}`),
    ...(result.gate_results.length ? [] : ["未配置门禁。"]), ""].join("\n");
}
export async function compareRuns(baseline: string, candidate: string, gates: string[]) {
  const path = async (value: string) => (await stat(value)).isDirectory() ? join(value, "results.jsonl") : value;
  const load = async (value: string) => (await Bun.file(value).text()).split(/\r?\n/).filter((line) => line.trim()).map((line) => rowSchema.parse(JSON.parse(line)) as EvalResult);
  const candidatePath = await path(candidate);
  const result = compareResults(await load(await path(baseline)), await load(candidatePath), gates);
  await Bun.write(join(dirname(candidatePath), "compare.json"), JSON.stringify(result, null, 2) + "\n");
  const markdown = renderComparison(result);
  await Bun.write(join(dirname(candidatePath), "compare.md"), markdown);
  console.log(markdown);
  return result.passed ? 0 : 1;
}
