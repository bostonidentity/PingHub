import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/schedules/[id]", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedid-")); process.env.PINGHUB_DATA_DIR = dir; vi.resetModules(); });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("GET/PUT/DELETE round-trip", async () => {
    const { createSchedule } = await import("@/lib/scheduler/store");
    const s = createSchedule({ name: "n", enabled: true, trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" }, steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true });
    const { GET, PUT, DELETE } = await import("@/app/api/schedules/[id]/route");

    expect((await (await GET(new Request("http://x"), ctx(s.id))).json()).name).toBe("n");
    const put = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ name: "n2" }) }), ctx(s.id));
    expect((await put.json()).name).toBe("n2");
    const del = await DELETE(new Request("http://x", { method: "DELETE" }), ctx(s.id));
    expect(del.status).toBe(200);
    expect((await GET(new Request("http://x"), ctx(s.id))).status).toBe(404);
  });
});
