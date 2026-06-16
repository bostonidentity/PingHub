import { describe, it, expect, vi, beforeEach } from "vitest";

const recordRun = vi.fn();
const getSchedule = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({
  getSchedule, recordRun, listSchedules: vi.fn(() => []),
}));
const runStep = vi.fn();
vi.mock("@/lib/scheduler/run-step", () => ({ runStep }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2026-06-17T02:00:00.000Z" }));

const baseSchedule = {
  id: "s1", name: "n", enabled: true,
  trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
  onError: "continue", catchUpIfMissed: true,
  nextRunAt: "2026-06-16T02:00:00.000Z", createdAt: "", updatedAt: "",
  steps: [{ type: "git-push" }, { type: "git-push" }],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("pause/resume/stop controls", () => {
  beforeEach(() => { recordRun.mockClear(); runStep.mockReset(); getSchedule.mockReset(); });

  it("pause holds the pipeline at a step boundary; resume continues", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    // First step controlled by a deferred promise so we can pause before step 2.
    let resolveFirst: (v: unknown) => void = () => {};
    runStep
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue({ status: "success", summary: "ok", durationMs: 1 });

    const { runSchedule, pauseSchedule, resumeSchedule, isPaused } =
      await import("@/lib/scheduler/engine");

    const run = runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    await flush(); // first step is now awaiting

    // Request a pause while the first step is in flight, then let it finish.
    pauseSchedule("s1");
    resolveFirst({ status: "success", summary: "ok", durationMs: 1 });
    await flush(); // pause gate before step 2 should now hold

    expect(isPaused("s1")).toBe(true);
    expect(runStep).toHaveBeenCalledTimes(1);

    resumeSchedule("s1");
    await run;

    expect(runStep).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "success" }), expect.any(String));
  });

  it("stop skips remaining steps and records status 'stopped'", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    let resolveFirst: (v: unknown) => void = () => {};
    runStep
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue({ status: "success", summary: "ok", durationMs: 1 });

    const { runSchedule, stopSchedule } = await import("@/lib/scheduler/engine");

    const run = runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    await flush();

    stopSchedule("s1");
    resolveFirst({ status: "success", summary: "ok", durationMs: 1 });
    await run;

    expect(runStep).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "stopped" }), expect.any(String));
  });
});
