import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MonitorScheduler } from "./scheduler";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("MonitorScheduler", () => {
  it("calls runOnce immediately on start", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const sched = new MonitorScheduler({ intervalMs: 60_000, runOnce });
    sched.start();
    expect(runOnce).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it("calls runOnce on each tick", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const sched = new MonitorScheduler({ intervalMs: 60_000, runOnce });
    sched.start();
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(runOnce).toHaveBeenCalledTimes(3); // 1 immediate + 2 ticks
    sched.stop();
  });

  it("stop clears the timer", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const sched = new MonitorScheduler({ intervalMs: 60_000, runOnce });
    sched.start();
    sched.stop();
    vi.advanceTimersByTime(120_000);
    expect(runOnce).toHaveBeenCalledTimes(1); // only the initial one
  });

  it("multiple starts are idempotent", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const sched = new MonitorScheduler({ intervalMs: 60_000, runOnce });
    sched.start();
    sched.start();
    sched.start();
    expect(runOnce).toHaveBeenCalledTimes(1); // not 3
    sched.stop();
  });
});
