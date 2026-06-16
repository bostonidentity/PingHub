import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("schedule store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
    process.env.PINGHUB_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("create → list → get → update → delete round-trips", async () => {
    const store = await import("@/lib/scheduler/store");
    const now = new Date("2026-06-16T00:00:00Z");
    const created = store.createSchedule({
      name: "nightly", enabled: true,
      trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
    }, now);

    expect(created.id).toBeTruthy();
    expect(created.nextRunAt).toBe("2026-06-16T02:00:00.000Z");
    expect(store.listSchedules()).toHaveLength(1);

    const updated = store.updateSchedule(created.id, { name: "renamed" }, now);
    expect(updated?.name).toBe("renamed");
    expect(store.getSchedule(created.id)?.name).toBe("renamed");

    store.deleteSchedule(created.id);
    expect(store.listSchedules()).toHaveLength(0);
  });

  it("recordRun maintains recentRuns history (most-recent first) and updates lastRun", async () => {
    const store = await import("@/lib/scheduler/store");
    const now = new Date("2026-06-16T00:00:00Z");
    const created = store.createSchedule({
      name: "test", enabled: true,
      trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
    }, now);

    const run1 = { at: "2026-06-16T01:00:00.000Z", status: "success" as const, durationMs: 1000, summary: "1/1 steps ok" };
    const run2 = { at: "2026-06-16T02:00:00.000Z", status: "failed" as const, durationMs: 500, summary: "0/1 steps ok" };

    store.recordRun(created.id, run1, "2026-06-17T02:00:00.000Z");
    store.recordRun(created.id, run2, "2026-06-17T02:00:00.000Z");

    const s = store.getSchedule(created.id);
    expect(s?.recentRuns).toHaveLength(2);
    // Most recent first
    expect(s?.recentRuns?.[0]).toMatchObject({ at: run2.at, status: "failed" });
    expect(s?.recentRuns?.[1]).toMatchObject({ at: run1.at, status: "success" });
    // lastRun matches the most recent call
    expect(s?.lastRun).toMatchObject({ at: run2.at, status: "failed" });
  });
});
