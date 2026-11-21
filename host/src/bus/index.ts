type Handler<T> = (payload: T) => void | Promise<void>;

export class EventBus<Events extends object> {
  private readonly topics = new Map<keyof Events, Set<Handler<never>>>();

  constructor(
    private readonly onError: (error: unknown, topic: keyof Events) => void | Promise<void>,
  ) {}

  subscribe<Topic extends keyof Events>(topic: Topic, handler: Handler<Events[Topic]>): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
    }
    const subscription: Handler<Events[Topic]> = (payload) => handler(payload);
    handlers.add(subscription as Handler<never>);

    return () => {
      handlers.delete(subscription as Handler<never>);
      if (handlers.size === 0 && this.topics.get(topic) === handlers) {
        this.topics.delete(topic);
      }
    };
  }

  publish<Topic extends keyof Events>(topic: Topic, payload: Events[Topic]): void {
    const handlers = [...(this.topics.get(topic) ?? [])];
    for (const handler of handlers) {
      try {
        const result = (handler as Handler<Events[Topic]>)(payload);
        Promise.resolve(result).catch((error: unknown) => this.report(error, topic));
      } catch (error) {
        this.report(error, topic);
      }
    }
  }

  private report(error: unknown, topic: keyof Events): void {
    try {
      Promise.resolve(this.onError(error, topic)).catch(() => {});
    } catch {}
  }
}
