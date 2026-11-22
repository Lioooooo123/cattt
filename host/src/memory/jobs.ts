import type { JobRunner } from "../jobs/index.ts";
import { ModelReplyError, retryableModelCode } from "../llm/errors.ts";
import type { ModelClient } from "../llm/types.ts";
import { failJob, getHeldJob } from "../store/jobs.ts";
import {
  commitMemoryExtraction, loadMemoryExtraction, MEMORY_EXTRACTION_QUEUE, memoryExtractionJobSchema,
} from "../store/memory-extraction.ts";
import type { PairMemoryWriter } from "../store/memory-extraction.ts";
import { extractMemoryForMessage } from "./extraction.ts";

export function registerMemoryExtraction(
  runner: JobRunner,
  { model, writePair }: { model?: ModelClient; writePair?: PairMemoryWriter } = {},
): void {
  runner.register(MEMORY_EXTRACTION_QUEUE, {
    schema: memoryExtractionJobSchema,
    concurrency: 1,
    async handler(source, { store, clock, models, job, signal }) {
      signal.throwIfAborted();
      const snapshot = loadMemoryExtraction(store.db, source);
      if (!snapshot) {
        return;
      }
      const client = model ?? models.text("memory_extract", { jobId: job.id });
      let sourceChanged: "unavailable" | "refresh" | undefined;
      try {
        const result = await extractMemoryForMessage({ ...snapshot.input, signal }, client, () => {
          const current = getHeldJob(store.db, clock, job) && loadMemoryExtraction(store.db, source);
          if (!current || JSON.stringify(current.input) !== JSON.stringify(snapshot.input)
            || JSON.stringify([...current.context]) !== JSON.stringify([...snapshot.context])) {
            sourceChanged = current ? "refresh" : "unavailable";
            throw new Error("memory_source_changed");
          }
        });
        signal.throwIfAborted();
        commitMemoryExtraction(store.db, clock, job, source, snapshot, result, writePair);
      } catch (error) {
        if (sourceChanged === "refresh") { return { deferUntil: clock.wallMs() }; }
        if (sourceChanged === "unavailable") { return; }
        if (!signal.aborted && error instanceof ModelReplyError && !retryableModelCode(error.code)) {
          failJob(store.db, clock, job, error, clock.wallMs(), true);
          return;
        }
        throw error;
      }
    },
  });
}
