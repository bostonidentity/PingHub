import { describe, it, expect } from "vitest";
import { presetToCron, computeNextRun } from "@/lib/scheduler/cron";
import type { Trigger } from "@/lib/scheduler/types";

describe("presetToCron", () => {
  it("hourly at minute 30", () => {
    expect(presetToCron({ every: "hour", minute: 30 })).toBe("30 * * * *");
  });
  it("daily at 02:15", () => {
    expect(presetToCron({ every: "day", time: "02:15" })).toBe("15 2 * * *");
  });
  it("weekly Mon+Wed at 09:00", () => {
    expect(presetToCron({ every: "week", days: [1, 3], time: "09:00" })).toBe("0 9 * * 1,3");
  });
});

describe("computeNextRun", () => {
  it("computes the next daily run after a fixed instant (UTC)", () => {
    const trig: Trigger = { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" };
    const from = new Date("2026-06-16T03:00:00Z");
    const next = computeNextRun(trig, from);
    expect(next).toBe("2026-06-17T02:00:00.000Z");
  });

  it("honors an explicit cron expression", () => {
    const trig: Trigger = { kind: "cron", cron: "0 0 * * *", timezone: "UTC" };
    const from = new Date("2026-06-16T05:00:00Z");
    expect(computeNextRun(trig, from)).toBe("2026-06-17T00:00:00.000Z");
  });
});
