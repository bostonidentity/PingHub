import { describe, it, expect, vi, beforeEach } from "vitest";

const listSchedules = vi.fn();
const recordRun = vi.fn();
const getSchedule = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({ listSchedules, getSchedule, recordRun }));
vi.mock("@/lib/scheduler/run-step", () => ({ runStep: vi.fn() }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2999-01-01T00:00:00.000Z" }));

describe("rollForwardSkipped", () => {
  beforeEach(() => { recordRun.mockClear(); });

  it("rolls a past-due non-catch-up schedule forward without running it", async () => {
    listSchedules.mockReturnValue([{
      id: "s1", enabled: true, catchUpIfMissed: false,
      trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" },
      steps: [], onError: "stop", name: "n",
      nextRunAt: "2020-01-01T00:00:00.000Z", createdAt: "", updatedAt: "",
    }]);
    const { rollForwardSkipped } = await import("@/lib/scheduler/engine");
    rollForwardSkipped(new Date("2026-06-16T00:00:00Z"));
    expect(recordRun).toHaveBeenCalledWith("s1",
      expect.objectContaining({ status: "skipped-overlap" }), "2999-01-01T00:00:00.000Z");
  });
});
