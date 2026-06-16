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
  onError: "stop", catchUpIfMissed: true,
  nextRunAt: "2026-06-16T02:00:00.000Z", createdAt: "", updatedAt: "",
  steps: [{ type: "git-push" }],
};

describe("isRunning / runningIds", () => {
  beforeEach(() => { recordRun.mockClear(); runStep.mockReset(); getSchedule.mockReset(); });

  it("reports schedule as running while its step is in flight, then false after completion", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });

    let resolveStep: (v: unknown) => void = () => {};
    runStep.mockImplementation(() => new Promise((res) => { resolveStep = res; }));

    const { runSchedule, isRunning, runningIds } = await import("@/lib/scheduler/engine");

    const promise = runSchedule("s1", new Date("2026-06-16T02:00:05Z"));

    // While step is pending, the schedule is in-flight
    expect(isRunning("s1")).toBe(true);
    expect(runningIds()).toContain("s1");

    // Resolve the step
    resolveStep({ status: "success", summary: "ok", durationMs: 100 });
    await promise;

    // After completion, no longer running
    expect(isRunning("s1")).toBe(false);
    expect(runningIds()).not.toContain("s1");
  });
});
