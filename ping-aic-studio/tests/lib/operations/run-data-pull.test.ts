import { describe, it, expect, vi, beforeEach } from "vitest";

const startJob = vi.fn(() => ({ id: "job-1", status: "running" }));
const getJob = vi.fn(() => ({ id: "job-1", status: "completed" }));
const runPull = vi.fn(async () => {});
vi.mock("@/lib/data/job-registry", () => ({
  getRegistry: () => ({ startJob, getJob }),
  JobConflictError: class JobConflictError extends Error {},
}));
vi.mock("@/lib/data/pull-runner", () => ({ runPull: (a: unknown) => (runPull as (x: unknown) => unknown)(a) }));
vi.mock("@/lib/iga-api", () => ({ getAccessToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/fr-config", () => ({ getEnvironments: () => [{ name: "dev", pageSize: 100 }] }));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-3" })) }));

describe("runDataPull", () => {
  beforeEach(() => { startJob.mockClear(); runPull.mockClear(); });

  it("starts a job, awaits the runner, and reports success", async () => {
    const { runDataPull } = await import("@/lib/operations/run-data-pull");
    const result = await runDataPull({ environment: "dev", managedObjects: ["alpha_user"], envVars: { ORIGIN_AM: "x" } }, () => {});
    expect(startJob).toHaveBeenCalledWith("dev", ["alpha_user"]);
    expect(runPull).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });
});
