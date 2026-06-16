import { describe, it, expect, vi, beforeEach } from "vitest";

const runSchedule = vi.fn(async () => "success");
vi.mock("@/lib/scheduler/engine", () => ({ runSchedule }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/schedules/[id]/run", () => {
  beforeEach(() => runSchedule.mockClear());
  it("invokes runSchedule and returns the status", async () => {
    const { POST } = await import("@/app/api/schedules/[id]/run/route");
    const res = await POST(new Request("http://x", { method: "POST" }), ctx("s1"));
    expect(runSchedule).toHaveBeenCalledWith("s1");
    expect((await res.json()).status).toBe("success");
  });
});
