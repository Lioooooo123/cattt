import type { EvalCase } from "./schema.ts";
import type { ModelCallTrace } from "./trace.ts";

export interface Score { scorer: string; passed: boolean; detail: string; score?: number; error?: string }
export function scoreCase(expect: EvalCase["expect"], reply: string, trace: ModelCallTrace[], latency: number): Score[] {
  const scores: Score[] = [];
  const context = trace.map((call) => call.request.system ?? "").join("\n");
  const check = (scorer: string, values: string[], predicate: (value: string) => boolean) => {
    if (!values.length) return;
    const failed = values.filter((value) => !predicate(value));
    scores.push({ scorer, passed: !failed.length, detail: failed.length ? `未满足：${JSON.stringify(failed)}` : `满足 ${values.length} 项` });
  };
  check("reply_contains", expect.reply_contains, (value) => reply.includes(value));
  check("reply_not_contains", expect.reply_not_contains, (value) => !reply.includes(value));
  check("reply_regex", expect.reply_regex, (value) => new RegExp(value, "u").test(reply));
  check("context_includes", expect.context_includes, (value) => trace.length > 0 && context.includes(value));
  check("context_excludes", expect.context_excludes, (value) => trace.length > 0 && !context.includes(value));
  if (expect.max_latency_ms !== undefined) scores.push({
    scorer: "max_latency_ms", passed: latency <= expect.max_latency_ms,
    detail: `${latency.toFixed(1)}ms / ${expect.max_latency_ms}ms`,
  });
  return scores;
}
