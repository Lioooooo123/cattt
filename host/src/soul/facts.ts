import { z } from "zod";
import { businessId } from "../replication/types.ts";
import { destinationIds } from "../world/protocol.ts";
import { timeZoneSchema } from "./diary-date.ts";
import { habitSchema, messageProofSchema, soulChangeSchema, stateSchema } from "./rules.ts";

const date = z.iso.date();
const instant = z.int().nonnegative();
const zone = timeZoneSchema;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const card = z.strictObject({ id: businessId, sha256: hash });
const diaryProof = z.strictObject({ kind: z.literal("diary"), id: businessId, rev: z.int().positive() });
export const diarySourceSchema = z.discriminatedUnion("kind", [messageProofSchema, diaryProof]);
export const confirmDiarySchema = z.strictObject({
  kind: z.enum(["message", "diary"]), id: businessId, revision: z.int().positive(),
});
export const diaryWriterSchema = z.strictObject({
  provider: z.enum(["local", "mock", "fallback"]), modelId: z.string().min(1).max(120).nullable(),
}).refine(({ provider, modelId }) => (provider === "fallback") === (modelId === null));

export const diaryDraftSchema = z.strictObject({
  reflection: z.string().trim().min(1).max(180),
  cards: z.array(card).max(4),
  inputs: z.array(card).max(12),
  writer: diaryWriterSchema,
});
export type DiaryDraft = z.infer<typeof diaryDraftSchema>;

export const catFactSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("soul_edit"), version: z.int().min(2), source: messageProofSchema, change: soulChangeSchema }),
  z.strictObject({ type: z.literal("soul_withdrawal"), version: z.int().min(2), entryId: businessId, memberId: businessId }),
  z.strictObject({
    type: z.literal("legacy_soul"), version: z.int().positive().nullable(), sourceHash: hash.nullable(),
    entries: z.array(z.strictObject({ source: messageProofSchema, change: habitSchema })).max(3),
    state: z.strictObject({ source: messageProofSchema, change: stateSchema, sourceHash: hash }).nullable(),
    unmapped: z.int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("diary_calendar"), startDay: date, timeZone: zone }),
  z.strictObject({ type: z.literal("diary_timezone"), timeZone: zone, version: z.int().positive() }),
  z.strictObject({ type: z.literal("diary_observation"), day: date, timeZone: zone,
    destination: z.enum(destinationIds), observedAt: instant }),
  z.strictObject({ type: z.literal("diary_source"), memberId: businessId, source: diarySourceSchema }),
  z.strictObject({ type: z.literal("diary_plan"), day: date, timeZone: zone, startAt: instant, endAt: instant }),
  z.strictObject({ type: z.literal("daily_diary"), day: date, planId: businessId,
    ...diaryDraftSchema.shape, inputHash: hash }),
]);

export type CatFact = z.infer<typeof catFactSchema>;
export type FactsOf<K extends CatFact["type"]> = Extract<CatFact, { type: K }>;
export type DiarySource = z.infer<typeof diarySourceSchema>;
export type ConfirmDiary = z.infer<typeof confirmDiarySchema>;
export type DiaryWriter = z.infer<typeof diaryWriterSchema>;

export function catFactKey(fact: CatFact): string {
  switch (fact.type) {
    case "legacy_soul":
    case "diary_calendar": return "initial";
    case "soul_edit":
    case "soul_withdrawal": return String(fact.version);
    case "diary_timezone": return String(fact.version);
    case "diary_observation": return `${fact.day}:${fact.destination}`;
    case "diary_source": return fact.source.kind === "message"
      ? `message:${fact.source.sourceMessageId}:${fact.source.sourceRevision}`
      : `diary:${fact.source.id}:${fact.source.rev}`;
    case "diary_plan":
    case "daily_diary": return fact.day;
  }
}
