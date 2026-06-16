import { describe, it, expect, vi } from "vitest";

/**
 * Models the production bug: in Next.js the scheduler (from instrumentation) and
 * the API route handlers can load engine.ts / log-buffer.ts as SEPARATE module
 * instances in the same process. A timer-fired run populates one instance's
 * in-memory state; the API reads the other's. We simulate the two instances with
 * vi.resetModules() and assert the state is shared (globalThis-backed).
 */

const getSchedule = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({
  getSchedule,
  listSchedules: vi.fn(() => []),
  recordRun: vi.fn(),
}));

let releaseStep: () => void = () => {};
const runStep = vi.fn(
  () => new Promise((res) => { releaseStep = () => res({ status: "success", summary: "ok", durationMs: 1 }); }),
);
vi.mock("@/lib/scheduler/run-step", () => ({ runStep }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2999-01-01T00:00:00.000Z" }));

const sched = {
  id: "s1", name: "n", enabled: true, onError: "stop", catchUpIfMissed: true,
  trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
  steps: [{ type: "git-push" }],
  nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "", updatedAt: "",
};

describe("scheduler shared state across module instances", () => {
  it("running state is visible from a second module instance", async () => {
    getSchedule.mockReturnValue({ ...sched });
    const a = await import("@/lib/scheduler/engine");
    void a.runSchedule("s1"); // starts; blocks on the never-resolving runStep
    expect(a.runningIds()).toContain("s1");

    vi.resetModules(); // simulate Next loading a SECOND instance of the module
    const b = await import("@/lib/scheduler/engine");
    expect(b.runningIds()).toContain("s1"); // must be shared

    releaseStep(); // let the run finish so it doesn't leak
    await new Promise((r) => setTimeout(r, 0));
  });

  it("live log buffer is visible from a second module instance", async () => {
    const a = await import("@/lib/scheduler/log-buffer");
    a.startLog("x");
    a.appendLog("x", { type: "stdout", data: "hi" });

    vi.resetModules();
    const b = await import("@/lib/scheduler/log-buffer");
    expect(b.getLog("x")?.events.length).toBe(1); // must be shared
  });
});
