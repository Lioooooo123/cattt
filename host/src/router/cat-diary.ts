import type { JobRunner } from "../jobs/index.ts";
import { diaryPublicationSchema, publishCatDiary, publishQueue } from "../store/cat-diary.ts";

export function registerCatDiaryPublisher(runner: JobRunner) {
  runner.register(publishQueue, {
    schema: diaryPublicationSchema,
    concurrency: 1,
    handler(draft, ctx) {
      ctx.signal.throwIfAborted();
      publishCatDiary(ctx, draft, ctx.job);
    },
  });
}
