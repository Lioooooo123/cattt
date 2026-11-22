export async function prepareStartup(
  compile: () => Promise<unknown>,
  progress: (phase: string, duration: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const started = performance.now();
  const report = (phase: string) => progress(phase, performance.now() - started);
  report('compileStarted');
  const heartbeat = setInterval(() => report('compiling'), 1000);
  const stop = () => clearInterval(heartbeat);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    await compile();
    report('compileFinished');
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
  }
}
