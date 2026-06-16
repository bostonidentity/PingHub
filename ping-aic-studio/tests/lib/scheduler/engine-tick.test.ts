import { describe, it, expect, vi, beforeEach } from "vitest";

const listSchedules = vi.fn();
const getSchedule = vi.fn((id) => listSchedules().find((s: { id: string }) => s.id === id));
const recordRun = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({ listSchedules, getSchedule, recordRun }));
const runStep = vi.fn(async () => ({ status: "success", summary: "ok", durationMs: 1 }));
vi.mock("@/lib/scheduler/run-step", () => ({ runStep }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2999-01-01T00:00:00.000Z" }));

function sched(over: Record<string, unknown>) {
  return { id: "s1", name: "n", enabled: true, onError: "stop", catchUpIfMissed: true,
    trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
    steps: [{ type: "git-push" }], nextRunAt: "2026-06-16T02:00:00.000Z",
    createdAt: "", updatedAt: "", ...over };
}

describe("tick", () => {
  beforeEach(() => { runStep.mockClear(); recordRun.mockClear(); });

  it("fires a due, enabled schedule", async () => {
    listSchedules.mockReturnValue([sched({ nextRunAt: "2026-06-16T01:59:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  it("does not fire a schedule whose nextRunAt is in the future", async () => {
    listSchedules.mockReturnValue([sched({ nextRunAt: "2026-06-16T03:00:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).not.toHaveBeenCalled();
  });

  it("does not fire a disabled schedule", async () => {
    listSchedules.mockReturnValue([sched({ enabled: false, nextRunAt: "2026-06-16T01:00:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).not.toHaveBeenCalled();
  });
});
