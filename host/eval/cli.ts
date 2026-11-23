import { resolve } from "node:path";
import { loadCases, runCases } from "./run.ts";
import { summarizeResults, writeReport } from "./report.ts";
import { compareRuns } from "./compare.ts";

export async function main(args: string[]) {
  const usage = "用法：bun run eval run --suite <名称|all> --mode <scripted|env> [--case ID] [--out 目录]";
  const command = args.shift();
  if (command !== "run" && command !== "compare") throw new Error(usage);
  const options = new Map<string, string>();
  const gates: string[] = [];
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (command === "compare" && key === "--fail-if-drop" && value) { gates.push(value); continue; }
    const allowed = command === "run" ? ["--suite", "--mode", "--case", "--out", "--judge"] : ["--baseline", "--candidate"];
    if (!allowed.includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  if (command === "compare") {
    if (!options.get("--baseline") || !options.get("--candidate")) throw new Error("对比须指定 --baseline 和 --candidate");
    return compareRuns(options.get("--baseline")!, options.get("--candidate")!, gates);
  }
  const suite = options.get("--suite");
  const mode = options.get("--mode");
  if (!suite || mode !== "scripted" && mode !== "env") throw new Error(usage);
  const cases = (await loadCases(suite)).filter((item) => !options.has("--case") || item.id === options.get("--case"));
  if (!cases.length) throw new Error("未找到匹配用例");
  const directory = resolve(options.get("--out") ?? resolve(import.meta.dir, "../eval-runs", new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`));
  const judge = options.get("--judge") ?? "none";
  if (judge !== "none" && judge !== "env") throw new Error("--judge 只支持 none 或 env");
  const results = await runCases(cases, mode, judge);
  await writeReport(results, directory);
  const { overall } = summarizeResults(results);
  console.log(`评测完成：${overall.passed}/${overall.total} 通过，${overall.failed} 失败`);
  console.log(`报告：${directory}/report.md`);
  return overall.failed ? 1 : 0;
}
if (import.meta.main) {
  try { process.exitCode = await main(Bun.argv.slice(2)); }
  catch (error) { console.error(`评测失败：${String(error)}`); process.exitCode = 1; }
}
