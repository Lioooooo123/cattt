import type { ModelClient, ModelEvent, ModelRequest } from './types.ts';

export function scriptedClient(steps: readonly (readonly ModelEvent[] | Error)[] | ((request: ModelRequest, index: number) => readonly ModelEvent[] | Promise<readonly ModelEvent[]>)): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider: 'mock', modelId: 'scripted', requests,
    async *stream(request, signal) {
      signal?.throwIfAborted(); request.signal?.throwIfAborted();
      const index = requests.length;
      requests.push(request);
      const step = typeof steps === 'function' ? await steps(request, index) : steps[index];
      if (step instanceof Error) throw step;
      if (!step) throw new Error('scriptedClient 没有更多响应');
      for (const event of step) {
        signal?.throwIfAborted(); request.signal?.throwIfAborted();
        yield event;
      }
    },
  };
}
