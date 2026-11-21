import type { ModelMessage } from './types.ts';
import { z } from 'zod';

// UTF-8 字节作保守估算单位；64KiB 总量，预留 8KiB 输出。
export const INPUT_BUDGET = 56 * 1024;
export function toolSchemas(tools: Record<string, { description?: string; inputSchema?: unknown }>) {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, { description: t.description,
    inputSchema: t.inputSchema instanceof z.ZodType
      ? z.toJSONSchema(t.inputSchema instanceof z.ZodPipe ? t.inputSchema.in : t.inputSchema)
      : t.inputSchema }]));
}
export function estimateRequest(instructions: string, messages: ModelMessage[], tools: unknown): number {
  return Buffer.byteLength(JSON.stringify({ instructions, messages, tools }), 'utf8') + 1024;
}
export function budgetMessages(instructions: string, messages: ModelMessage[], tools: unknown, preserveUsers = false): ModelMessage[] {
  let result = messages.slice();
  while (estimateRequest(instructions, result, tools) > INPUT_BUDGET) {
    const next = preserveUsers ? -1 : result.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next >= 0) { result = result.slice(next); continue; }
    const calls = result.flatMap((m, i) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(p => p.type === 'tool-call') ? [i] : []);
    if (calls.length < 2) throw new Error('model_input_budget: 必需上下文超过输入预算');
    const start = calls[0]!;
    let end = start + 1;
    while (end < result.length && result[end]!.role === 'tool') end++;
    result = [...result.slice(0, start), ...result.slice(end)];
  }
  return result;
}
