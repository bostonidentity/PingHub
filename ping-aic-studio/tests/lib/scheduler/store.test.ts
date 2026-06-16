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
});
