import { describe, it, expect, vi, beforeEach } from "vitest";

const pauseSchedule = vi.fn();
const resumeSchedule = vi.fn();
const stopSchedule = vi.fn();
vi.mock("@/lib/scheduler/engine", () => ({ pauseSchedule, resumeSchedule, stopSchedule }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://x", { method: "POST" });

describe("/api/schedules/[id] control routes", () => {
  beforeEach(() => { pauseSchedule.mockClear(); resumeSchedule.mockClear(); stopSchedule.mockClear(); });

  it("pause invokes pauseSchedule and returns { ok: true }", async () => {
    const { POST } = await import("@/app/api/schedules/[id]/pause/route");
    const res = await POST(req(), ctx("s1"));
    expect(pauseSchedule).toHaveBeenCalledWith("s1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("resume invokes resumeSchedule and returns { ok: true }", async () => {
    const { POST } = await import("@/app/api/schedules/[id]/resume/route");
    const res = await POST(req(), ctx("s1"));
    expect(resumeSchedule).toHaveBeenCalledWith("s1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("stop invokes stopSchedule and returns { ok: true }", async () => {
    const { POST } = await import("@/app/api/schedules/[id]/stop/route");
    const res = await POST(req(), ctx("s1"));
    expect(stopSchedule).toHaveBeenCalledWith("s1");
    expect(await res.json()).toEqual({ ok: true });
  });
});
