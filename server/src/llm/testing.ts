import type { ModelClient, ModelEvent, ModelRequest } from './types.ts';

export function scriptedClient(steps: readonly (readonly ModelEvent[] | Error)[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider: 'mock', modelId: 'scripted', requests,
    async *stream(request, signal) {
      signal?.throwIfAborted(); request.signal?.throwIfAborted();
      const step = steps[requests.length];
      requests.push(request);
      if (step instanceof Error) throw step;
      if (!step) throw new Error('scriptedClient 没有更多响应');
      for (const event of step) {
        signal?.throwIfAborted(); request.signal?.throwIfAborted();
        yield event;
      }
    },
  };
}
