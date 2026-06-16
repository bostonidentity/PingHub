import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("/api/schedules", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedapi-")); process.env.PINGHUB_DATA_DIR = dir; vi.resetModules(); });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("POST creates and GET lists", async () => {
    const { POST, GET } = await import("@/app/api/schedules/route");
    const body = { name: "nightly", enabled: true,
      trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true };
    const created = await (await POST(new Request("http://x/api/schedules", { method: "POST", body: JSON.stringify(body) }))).json();
    expect(created.id).toBeTruthy();
    const list = await (await GET()).json();
    expect(list).toHaveLength(1);
  });

  it("POST rejects an invalid cron with 400", async () => {
    const { POST } = await import("@/app/api/schedules/route");
    const body = { name: "bad", enabled: true,
      trigger: { kind: "cron", cron: "not a cron", timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true };
    const res = await POST(new Request("http://x/api/schedules", { method: "POST", body: JSON.stringify(body) }));
    expect(res.status).toBe(400);
  });
});
