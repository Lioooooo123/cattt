import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvalResult } from "./run.ts";

function aggregate(results: readonly EvalResult[]) {
  const latencies = results.map((item) => item.latency_ms).sort((a, b) => a - b);
  const passed = results.filter((item) => item.passed).length;
  return { total: results.length, passed, failed: results.length - passed,
    pass_rate: results.length ? passed / results.length : null,
    avg_latency_ms: results.length ? latencies.reduce((a, b) => a + b, 0) / results.length : null,
    p95_latency_ms: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null };
}
export function summarizeResults(results: readonly EvalResult[]) {
  const group = (keys: (result: EvalResult) => string[]) => {
    const groups = new Map<string, EvalResult[]>();
    for (const result of results) for (const key of new Set(keys(result))) groups.set(key, [...(groups.get(key) ?? []), result]);
    return Object.fromEntries([...groups].map(([key, rows]) => [key, aggregate(rows)]));
  };
  return { overall: aggregate(results), by_suite: group((result) => [result.suite]), by_tag: group((result) => result.tags),
    models: [...new Map(results.map(({ provider, model, mode }) => [JSON.stringify([provider, model, mode]), { provider, model, mode }])).values()] };
}
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
export function renderReport(results: readonly EvalResult[]): string {
  const summary = summarizeResults(results);
  const percent = (rate: number | null) => rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
  const table = (groups: typeof summary.by_suite) => ["| 名称 | 通过 / 总数 | 通过率 | 平均耗时 ms | P95 ms |", "| --- | --- | --- | --- | --- |",
    ...Object.entries(groups).map(([key, value]) => `| ${cell(key)} | ${value.passed} / ${value.total} | ${percent(value.pass_rate)} | ${value.avg_latency_ms?.toFixed(1) ?? "—"} | ${value.p95_latency_ms?.toFixed(1) ?? "—"} |`)];
  const lines = ["# 团子评测报告", "", "## 总览", "",
    `通过 ${summary.overall.passed} / ${summary.overall.total}，通过率 ${percent(summary.overall.pass_rate)}。`,
    `平均耗时 ${summary.overall.avg_latency_ms?.toFixed(1) ?? "—"} ms，P95 ${summary.overall.p95_latency_ms?.toFixed(1) ?? "—"} ms。`,
    `模型：${summary.models.map((item) => `${item.provider}/${item.model}（${item.mode}）`).join("、") || "无"}。`,
    "", "离线 scripted 回复由用例提供，仅验证评测管线与生产上下文规则，不代表真实模型回复质量。judge=env 时逐条标准单独计分；裁判与目标同源时并非独立人工评审。耗时包含状态准备及目标执行，不含另记的裁判耗时。原始 trace 含原话与记忆，请按敏感数据保管。",
    "", "## 按套件", "", ...table(summary.by_suite), "", "## 按标签", "", ...table(summary.by_tag), "", "## 失败用例", ""];
  const failures = results.filter((item) => !item.passed);
  if (!failures.length) lines.push("无。");
  for (const item of failures) {
    lines.push(`### ${cell(item.case_id)}`, "", ...item.scores.filter((score) => !score.passed).map((score) => `- ${score.scorer}：${cell(score.detail)}`));
    if (item.error) lines.push(`- 错误：${cell(item.error)}`);
    for (const score of item.scores.filter((score) => score.error)) lines.push(`- ${score.scorer} 错误：${cell(score.error!)}`);
    lines.push(`- 回复摘录：${cell(item.reply.slice(0, 300)) || "（空）"}`, "");
  }
  return lines.join("\n") + "\n";
}
export async function writeReport(results: readonly EvalResult[], directory: string) {
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "results.jsonl"), results.map((item) => JSON.stringify(item)).join("\n") + "\n");
  await Bun.write(join(directory, "summary.json"), JSON.stringify(summarizeResults(results), null, 2) + "\n");
  await Bun.write(join(directory, "report.md"), renderReport(results));
}
