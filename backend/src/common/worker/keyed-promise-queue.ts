export interface KeyedPromiseQueueOptions {
  ttlMs?: number;
  onPreviousError?: (key: string, err: unknown) => void;
  onExpired?: (key: string) => void;
}

export class KeyedPromiseQueue<T = unknown> {
  private readonly tails = new Map<string, Promise<T>>();

  constructor(private readonly options: KeyedPromiseQueueOptions = {}) {}

  run<R extends T>(
    key: string,
    fn: () => Promise<R>,
    opts: { continueAfterFailure?: boolean } = {}
  ): Promise<R> {
    const previous = this.tails.get(key);
    const task = previous
      ? opts.continueAfterFailure
        ? previous
            .catch((err: unknown) => {
              this.options.onPreviousError?.(key, err);
            })
            .then(fn)
        : previous.then(fn)
      : Promise.resolve().then(fn);

    this.tails.set(key, task);
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.options.ttlMs !== undefined) {
      cleanupTimer = setTimeout(() => {
        if (this.tails.get(key) === task) {
          this.tails.delete(key);
          this.options.onExpired?.(key);
        }
      }, this.options.ttlMs);
      cleanupTimer.unref?.();
    }

    void task.then(
      () => this.cleanup(key, task, cleanupTimer),
      () => this.cleanup(key, task, cleanupTimer)
    );
    return task;
  }

  private cleanup(
    key: string,
    task: Promise<T>,
    cleanupTimer: ReturnType<typeof setTimeout> | null
  ): void {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (this.tails.get(key) === task) this.tails.delete(key);
  }
}
