export interface SchedulerDeps {
  intervalMs: number;
  runOnce: () => Promise<void>;
}

export class MonitorScheduler {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.deps.runOnce();
    this.timer = setInterval(() => { void this.deps.runOnce(); }, this.deps.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
