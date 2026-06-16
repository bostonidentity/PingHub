import { describe, it, expect, vi, beforeEach } from "vitest";

const runSync = vi.fn(async () => ({ status: "success", summary: "ok", durationMs: 1 }));
const runGitPush = vi.fn(async () => ({ status: "success", summary: "pushed", durationMs: 1 }));
const runDataPull = vi.fn(async () => ({ status: "success", summary: "data", durationMs: 1 }));
vi.mock("@/lib/operations/run-sync", () => ({ runSync }));
vi.mock("@/lib/operations/run-git-push", () => ({ runGitPush }));
vi.mock("@/lib/operations/run-data-pull", () => ({ runDataPull }));
vi.mock("@/lib/scheduler/env-vars", () => ({ readEnvVars: () => ({ ORIGIN_AM: "x" }) }));

describe("runStep", () => {
  beforeEach(() => { runSync.mockClear(); runGitPush.mockClear(); runDataPull.mockClear(); });

  it("dispatches a sync step to runSync with scheduled trigger", async () => {
    const { runStep } = await import("@/lib/scheduler/run-step");
    const r = await runStep({ type: "sync", environment: "dev", scopes: ["journeys"] }, "sched-1", () => {});
    expect(runSync).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev", scopes: ["journeys"], trigger: "scheduled", scheduleId: "sched-1" }),
      expect.any(Function),
    );
    expect(r.status).toBe("success");
  });

  it("dispatches a git-push step to runGitPush", async () => {
    const { runStep } = await import("@/lib/scheduler/run-step");
    await runStep({ type: "git-push", message: "m" }, "sched-1", () => {});
    expect(runGitPush).toHaveBeenCalled();
  });
});
