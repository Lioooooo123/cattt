type Waiting = { foreground: boolean; grant(): void };

export class ModelAdmission {
  private active = 0;
  private readonly queue: Waiting[] = [];

  constructor(private readonly limit: number) {}

  async acquire(foreground: boolean, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (!this.limit) { return () => {}; }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.queue.indexOf(waiting);
        if (index >= 0) { this.queue.splice(index, 1); }
        reject(signal?.reason);
      };
      const waiting: Waiting = {
        foreground,
        grant: () => {
          signal?.removeEventListener("abort", cancel);
          if (signal?.aborted) { reject(signal.reason); return; }
          this.active++;
          resolve(() => {
            this.active--;
            this.dispatch();
          });
        },
      };
      this.queue.push(waiting);
      signal?.addEventListener("abort", cancel, { once: true });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length) {
      const firstForeground = this.queue.findIndex(({ foreground }) => foreground);
      const [next] = this.queue.splice(firstForeground < 0 ? 0 : firstForeground, 1);
      next!.grant();
    }
  }
}
