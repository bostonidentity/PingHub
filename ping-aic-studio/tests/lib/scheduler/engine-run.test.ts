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
  steps: [{ type: "git-push" }, { type: "git-push" }],
};

describe("runSchedule", () => {
  beforeEach(() => { recordRun.mockClear(); runStep.mockReset(); getSchedule.mockReset(); });

  it("runs all steps and records success", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    runStep.mockResolvedValue({ status: "success", summary: "ok", durationMs: 1, runId: "op-1" });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "success" }), expect.any(String));
  });

  it("stops after a failing step when onError=stop and records failed", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule, onError: "stop" });
    runStep
      .mockResolvedValueOnce({ status: "failed", summary: "bad", durationMs: 1 })
      .mockResolvedValueOnce({ status: "success", summary: "ok", durationMs: 1 });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "failed" }), expect.any(String));
  });

  it("records failed when all steps fail under onError=continue", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule, onError: "continue", steps: [{ type: "git-push" }, { type: "git-push" }] });
    runStep.mockResolvedValue({ status: "failed", summary: "bad", durationMs: 1 });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "failed" }), expect.any(String));
  });

  it("records partial when some steps fail under onError=continue", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule, onError: "continue", steps: [{ type: "git-push" }, { type: "git-push" }] });
    runStep
      .mockResolvedValueOnce({ status: "failed", summary: "bad", durationMs: 1 })
      .mockResolvedValueOnce({ status: "success", summary: "ok", durationMs: 1 });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "partial" }), expect.any(String));
  });

  it("records lastRun with summary for a 2-step all-success run", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    runStep.mockResolvedValue({ status: "success", summary: "ok", durationMs: 500 });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(recordRun).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ summary: expect.stringContaining("steps ok") }),
      expect.any(String),
    );
  });

  it("skips a re-entrant run while one is in flight (overlap lock)", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule, steps: [{ type: "git-push" }] });
    let resolveStep: (v: unknown) => void = () => {};
    runStep.mockImplementation(() => new Promise((res) => { resolveStep = res; }));
    const { runSchedule } = await import("@/lib/scheduler/engine");
    const first = runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    const second = await runSchedule("s1", new Date("2026-06-16T02:00:06Z"));
    expect(second).toBe("skipped-overlap");
    resolveStep({ status: "success", summary: "ok", durationMs: 1 });
    await first;
  });
});
