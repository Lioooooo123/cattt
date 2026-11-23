import { withAbort } from "../llm/tool-loop.ts";

const FLUSH_MS = 24;
const FLUSH_LENGTH = 256;

async function nextBefore(pending: Promise<IteratorResult<string>>, deadline: number) {
  const remaining = deadline - performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, Math.ceil(remaining)));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** 首段立即发布；后续按时间或长度合并，避免每个 token 都写入 SQLite。 */
export async function* batchReplyDeltas(iterator: AsyncIterator<string>, signal: AbortSignal): AsyncGenerator<string> {
  let first = true;
  let buffer = "";
  let deadline = 0;
  let pending: Promise<IteratorResult<string>> | undefined;
  for (;;) {
    signal.throwIfAborted();
    if (buffer && performance.now() >= deadline) {
      yield buffer;
      buffer = "";
      continue;
    }
    let next: IteratorResult<string> | undefined;
    try {
      pending ??= withAbort(Promise.resolve(iterator.next()), signal);
      next = buffer ? await nextBefore(pending, deadline) : await pending;
    } catch (error) {
      signal.throwIfAborted();
      if (buffer) { yield buffer; }
      throw error;
    }
    signal.throwIfAborted();
    if (!next) {
      yield buffer;
      buffer = "";
      continue;
    }
    pending = undefined;
    if (next.done) {
      if (buffer) { yield buffer; }
      return;
    }
    const chunk = next.value;
    if (typeof chunk !== "string") { throw new TypeError("Replier 必须返回文本块"); }
    if (!chunk) { continue; }
    if (first) {
      first = false;
      yield chunk;
      continue;
    }
    if (!buffer) { deadline = performance.now() + FLUSH_MS; }
    buffer += chunk;
    if (buffer.length >= FLUSH_LENGTH) {
      yield buffer;
      buffer = "";
    }
  }
}
