// tests/lib/op-history-trigger.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("op-log trigger fields", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oplog-"));
    process.env.PINGHUB_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.PINGHUB_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists trigger and scheduleId on an op-log entry", async () => {
    const { appendOpLog, readOpLog } = await import("@/lib/op-history");
    appendOpLog({
      type: "pull",
      environment: "dev",
      scopes: ["journeys"],
      status: "success",
      startedAt: new Date(0).toISOString(),
      durationMs: 10,
      summary: "ok",
      trigger: "scheduled",
      scheduleId: "sched-1",
    });
    const rows = readOpLog();
    expect(rows[0].trigger).toBe("scheduled");
    expect(rows[0].scheduleId).toBe("sched-1");
  });
});
