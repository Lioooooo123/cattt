import type { JobRunner } from "../jobs/index.ts";
import type { Component, HostContext } from "../runtime/index.ts";
import {
  cardHash, diaryJobSchema, hasDiaryDraft, loadCatDiary, queue, scanCatDiary, submitCatDiaryDraft,
} from "../store/cat-diary.ts";
import { getHeldJob } from "../store/jobs.ts";
import { composeDailyDraft, dailyDiaryWriter, diaryInputSize, diaryReflection } from "./diary-writer.ts";
import { diaryWriterSchema } from "./facts.ts";
import type { DiaryWriter } from "./facts.ts";

const maxInputTokens = 3000;
const maxOutputTokens = 1600;

export function registerCatDiary(runner: JobRunner) {
  runner.register(queue, {
    schema: diaryJobSchema,
    concurrency: 1,
    timeoutMs: 25_000,
    async handler(payload, ctx) {
      if (hasDiaryDraft(ctx.store.db, payload)) return;
      const current = () => ctx.store.db.transaction((tx) => loadCatDiary(tx, ctx, payload));
      const loaded = current();
      if (!loaded) return;
      const { input, inputHash } = loaded;
      const model = ctx.config.dailyDiaryModel ?? dailyDiaryWriter(ctx.models, ctx.job.id);
      if (!model) return { deferUntil: ctx.clock.wallMs() + 30_000 };
      const cards = new Map(input.facts.map((card) => [card.id, cardHash(card)]));
      let reflection = diaryReflection;
      let selected: ReturnType<typeof cardHash>[] = [];
      let inputs: ReturnType<typeof cardHash>[] = [];
      let writer: DiaryWriter = { provider: "fallback", modelId: null };
      if (diaryInputSize(input) <= maxInputTokens) {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]);
        const canUse = () => !signal.aborted && !!getHeldJob(ctx.store.db, ctx.clock, ctx.job) && current()?.inputHash === inputHash;
        try {
          if (!canUse()) return { deferUntil: ctx.clock.wallMs() + 1000 };
          const raw = await model.generate(input, { purpose: "cat_diary", operationId: loaded.plan.id,
            maxInputTokens, maxOutputTokens, signal, canUse });
          signal.throwIfAborted();
          const draft = composeDailyDraft(raw, input.facts);
          // The model sees every offered card, including the cards it did not cite.
          writer = diaryWriterSchema.parse({ provider: model.provider, modelId: model.modelId });
          reflection = draft.reflection;
          selected = draft.factIds.map((id) => cards.get(id)!);
          inputs = [...cards.values()];
        } catch {
          ctx.signal.throwIfAborted();
        }
      }
      const result = submitCatDiaryDraft(ctx, payload, ctx.job, inputHash, { reflection, cards: selected, inputs, writer });
      if (result === "stale") return { deferUntil: ctx.clock.wallMs() + 1000 };
    },
  });
}

export class CatDiaryCalendar implements Component {
  readonly name = "cat-diary-calendar";
  private timer?: ReturnType<typeof setInterval>;

  start(ctx: HostContext) {
    const scan = () => {
      try {
        scanCatDiary(ctx);
      } catch (error) {
        if (ctx.config.onError) {
          Promise.resolve(ctx.config.onError(error, this.name)).catch(() => {});
        } else {
          console.error(error);
        }
      }
    };
    scan();
    this.timer = setInterval(scan, 30_000);
  }

  stop() {
    clearInterval(this.timer);
  }
}
