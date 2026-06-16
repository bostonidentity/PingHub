import { describe, it, expect } from "vitest";

describe("/api/schedules/[id]/log", () => {
  it("returns buffered events and the cursor", async () => {
    // Import the log-buffer and the route from the SAME module graph (no
    // resetModules between them) so they share one buffer instance.
    const { startLog, appendLog } = await import("@/lib/scheduler/log-buffer");
    startLog("s1");
    appendLog("s1", { type: "stdout", data: "hello" });
    appendLog("s1", { type: "stdout", data: "world" });

    const { GET } = await import("@/app/api/schedules/[id]/log/route");
    const res = await GET(
      new Request("http://x/api/schedules/s1/log?since=0"),
      { params: Promise.resolve({ id: "s1" }) },
    );
    const json = await res.json();
    expect(json.running).toBe(true);
    expect(json.events).toHaveLength(2);
    expect(json.events[1]).toEqual({ type: "stdout", data: "world" });
    expect(json.cursor).toBe(2);
  });

  it("honors the since cursor", async () => {
    const { startLog, appendLog } = await import("@/lib/scheduler/log-buffer");
    startLog("s2");
    appendLog("s2", { type: "stdout", data: "a" });
    appendLog("s2", { type: "stdout", data: "b" });

    const { GET } = await import("@/app/api/schedules/[id]/log/route");
    const res = await GET(
      new Request("http://x/api/schedules/s2/log?since=1"),
      { params: Promise.resolve({ id: "s2" }) },
    );
    const json = await res.json();
    expect(json.events).toHaveLength(1);
    expect(json.events[0]).toEqual({ type: "stdout", data: "b" });
    expect(json.cursor).toBe(2);
  });

  it("returns an empty payload for an unknown schedule", async () => {
    const { GET } = await import("@/app/api/schedules/[id]/log/route");
    const res = await GET(
      new Request("http://x/api/schedules/unknown/log?since=3"),
      { params: Promise.resolve({ id: "unknown" }) },
    );
    const json = await res.json();
    expect(json.events).toEqual([]);
    expect(json.cursor).toBe(3);
    expect(json.running).toBe(false);
  });
});
