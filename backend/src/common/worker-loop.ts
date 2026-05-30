export interface WorkerLoopOptions {
  run: () => Promise<number>;
  onError: (err: unknown) => void;
  fallbackDelayMs: number;
}

export class WorkerLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;

  constructor(private readonly options: WorkerLoopOptions) {}

  start(delayMs = 0): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.schedule(await this.options.run());
    } catch (err) {
      this.options.onError(err);
      this.schedule(this.options.fallbackDelayMs);
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(delayMs, 0)
    );
    this.timer.unref?.();
  }
}
