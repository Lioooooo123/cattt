import { z } from "zod";

const text = z.string().trim().min(1);
const conversation = z.object({ kind: z.enum(["group", "direct"]), member: text.optional() });
const memory = z.object({
  id: text, subject: text.nullable(), source: text, predicate: text, value: text,
  source_text: text, withdrawn: z.boolean().default(false), replaces: text.optional(),
});
export const evalCaseSchema = z.object({
  id: text, suite: text, target: z.enum(["chat", "worker"]), tags: z.array(text), description: text,
  setup: z.object({
    members: z.array(z.object({ id: text, name: text })).length(2),
    conversation,
    memories: z.array(memory).default([]),
    boundaries: z.array(z.object({ member: text, description: text })).default([]),
    prior_messages: z.array(z.object({ sender: text, text, conversation: conversation.optional() })).default([]),
  }),
  input: z.object({ text, sender: text }), scripted: z.string().optional(),
  scripted_steps: z.array(z.object({ calls: z.array(z.object({ name: text, input: z.record(z.string(), z.unknown()) })) })).optional(),
  expect: z.object({
    reply_contains: z.array(text).default([]), reply_not_contains: z.array(text).default([]),
    reply_regex: z.array(text.refine((pattern) => {
      try { new RegExp(pattern, "u"); return true; } catch { return false; }
    }, "正则表达式无效")).default([]),
    context_includes: z.array(text).default([]), context_excludes: z.array(text).default([]),
    max_latency_ms: z.number().nonnegative().finite().optional(), judge: z.union([text, z.array(text).min(1)]).optional(),
    tool_calls: z.array(text).default([]), report_status: text.optional(), report_contains: z.array(text).default([]),
    max_steps: z.number().int().positive().optional(),
  }),
}).superRefine((value, ctx) => {
  const ids = new Set(value.setup.members.map((member) => member.id));
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (ids.size !== 2 || ids.has("cat")) issue("成员 ID 须唯一且不能为 cat");
  const member = (id: string) => { if (!ids.has(id)) issue(`未知成员：${id}`); };
  const scope = (item: z.infer<typeof conversation>) => {
    if (item.kind === "direct" && !item.member) issue("单聊须指定成员");
    if (item.member) member(item.member);
  };
  scope(value.setup.conversation); member(value.input.sender);
  if (value.setup.conversation.kind === "direct" && value.setup.conversation.member !== value.input.sender) issue("发问成员须拥有单聊");
  const memories = new Set<string>();
  for (const item of value.setup.memories) {
    member(item.source); if (item.subject !== null) member(item.subject);
    if (memories.has(item.id)) issue(`重复记忆：${item.id}`);
    if (item.replaces && !memories.has(item.replaces)) issue("更正须引用前面的记忆");
    memories.add(item.id);
  }
  for (const item of value.setup.boundaries) member(item.member);
  for (const item of value.setup.prior_messages) {
    if (item.sender !== "cat") member(item.sender);
    const target = item.conversation ?? value.setup.conversation;
    scope(target);
    if (target.kind === "direct" && item.sender !== "cat" && item.sender !== target.member) issue("历史消息作者须拥有单聊");
  }
});
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalMode = "scripted" | "env";
