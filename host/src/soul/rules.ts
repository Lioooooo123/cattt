import { z } from "zod";
import { businessId } from "../replication/types.ts";

export const soulCore = "团子外表有些高冷，内心十分细腻。外在克制，把关心藏在细节里，自然流露少量猫咪语气与动作。";
export const habits = {
  response_length: {
    brief: "通常简短回应，认真问题仍说清楚。",
    balanced: "按话题需要自然展开，不为凑长度多说。",
  },
  advice: {
    only_when_asked: "对方明确征求建议时再给建议。",
    ask_first: "需要建议时先轻声问对方是否愿意听。",
  },
  cat_expression: {
    subtle: "猫咪语气与小动作更克制，少量自然流露。",
    natural: "自然使用少量“喵”和猫咪细节，不每句重复。",
  },
};
const habitSchemas = [
  z.strictObject({ kind: z.literal("response_length"), value: z.enum(["brief", "balanced"]) }),
  z.strictObject({ kind: z.literal("advice"), value: z.enum(["only_when_asked", "ask_first"]) }),
  z.strictObject({ kind: z.literal("cat_expression"), value: z.enum(["subtle", "natural"]) }),
] as const;
export const habitSchema = z.discriminatedUnion("kind", habitSchemas);
export type Habit = z.infer<typeof habitSchema>;
const energy = z.enum(["baseline", "resting", "awake"]);
const willingness = z.enum(["baseline", "quiet", "open"]);
export const baseline = { energy: "baseline", willingness: "baseline", expires_at: null } as const;
const stateFields = { energy, willingness };
const nickname = z.string().trim().min(1).max(24).regex(/^[\p{L}\p{M}\p{N} ·・'’-]+$/u);
const memberSchemas = [
  z.strictObject({ kind: z.literal("nickname"), value: nickname.nullable() }),
  z.strictObject({ kind: z.literal("relationship"), value: z.enum(["getting_to_know", "familiar"]) }),
] as const;
const duration = 24 * 60 * 60 * 1000;
export const stateSchema = z.strictObject({
  kind: z.literal("state"), ...stateFields, observedAt: z.int().nonnegative(), expiresAt: z.int().nonnegative(),
}).refine(({ observedAt, expiresAt }) => expiresAt > observedAt && expiresAt - observedAt <= duration);
export const soulChangeSchema = z.discriminatedUnion("kind", [...habitSchemas, ...memberSchemas, stateSchema]);
export const messageProofSchema = z.strictObject({
  kind: z.literal("message"), sourceMemberId: businessId, sourceMessageId: businessId, sourceRevision: z.int().positive(),
});
export const editSoulSchema = z.strictObject({
  expected_version: z.int().positive(),
  source: z.strictObject({ message_id: businessId, revision: z.int().positive() }),
  change: z.discriminatedUnion("kind", [...habitSchemas, ...memberSchemas, z.strictObject({
    kind: z.literal("state"), ...stateFields, duration_minutes: z.int().min(1).max(1440),
  })]),
});
export const withdrawSoulSchema = z.strictObject({
  expected_version: z.int().positive(), entry_id: businessId,
});
export type MessageProof = z.infer<typeof messageProofSchema>;
export type SoulChange = z.infer<typeof soulChangeSchema>;
export type SoulEdit = z.infer<typeof editSoulSchema>;
export type SoulWithdrawal = z.infer<typeof withdrawSoulSchema>;

export function habitText(habit: Habit): string {
  switch (habit.kind) {
    case "response_length": return habits.response_length[habit.value];
    case "advice": return habits.advice[habit.value];
    case "cat_expression": return habits.cat_expression[habit.value];
  }
}
