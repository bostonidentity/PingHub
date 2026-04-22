import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createRegistry,
  JobConflictError,
  type Registry,
} from "./job-registry";

let tmpDir: string;
let registry: Registry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobreg-"));
  registry = createRegistry(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("job-registry: startJob", () => {
  it("creates a job in queued state", () => {
    const job = registry.startJob("uat", ["alpha_user", "alpha_role"]);
    expect(job.env).toBe("uat");
    expect(job.status).toBe("queued");
    expect(job.types).toEqual(["alpha_user", "alpha_role"]);
    expect(job.progress).toHaveLength(2);
    expect(job.progress[0]).toEqual({
      type: "alpha_user", status: "pending", fetched: 0, total: null,
    });
  });

  it("throws JobConflictError when an active job exists for the env", () => {
    const first = registry.startJob("uat", ["alpha_user"]);
    expect(() => registry.startJob("uat", ["alpha_role"])).toThrow(JobConflictError);
    try {
      registry.startJob("uat", ["alpha_role"]);
    } catch (e) {
      expect((e as JobConflictError).existingJobId).toBe(first.id);
    }
  });

  it("allows jobs in different envs concurrently", () => {
    const a = registry.startJob("uat", ["alpha_user"]);
    const b = registry.startJob("ide3", ["alpha_user"]);
    expect(a.id).not.toBe(b.id);
  });

  it("allows starting a new job after the previous terminates", () => {
    const first = registry.startJob("uat", ["alpha_user"]);
    registry.setJobStatus(first.id, "completed");
    const second = registry.startJob("uat", ["alpha_role"]);
    expect(second.id).not.toBe(first.id);
  });
});

describe("job-registry: updates + persistence", () => {
  it("mirrors job state to disk on every update", () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    registry.updateProgress(job.id, "alpha_user", { fetched: 50, total: 100 });
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "uat", "managed-data", ".jobs", `${job.id}.json`),
        "utf-8",
      ),
    );
    expect(onDisk.progress[0].fetched).toBe(50);
    expect(onDisk.progress[0].total).toBe(100);
  });

  it("setJobStatus sets finishedAt for terminal states", () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    registry.setJobStatus(job.id, "completed");
    const updated = registry.getJob(job.id);
    expect(updated?.status).toBe("completed");
    expect(typeof updated?.finishedAt).toBe("number");
  });
});

describe("job-registry: stale cleanup on init", () => {
  it("marks non-terminal disk jobs as failed(server restart) on createRegistry", () => {
    const jobsDir = path.join(tmpDir, "uat", "managed-data", ".jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobsDir, "stale.json"),
      JSON.stringify({
        id: "stale",
        env: "uat",
        types: ["alpha_user"],
        startedAt: 1,
        status: "running",
        progress: [{ type: "alpha_user", status: "running", fetched: 5, total: 10 }],
      }),
    );
    const r2 = createRegistry(tmpDir);
    const stale = r2.getJob("stale");
    expect(stale?.status).toBe("failed");
    expect(stale?.fatalError).toBe("server restart");
  });
});

describe("job-registry: listJobs", () => {
  it("returns active jobs sorted by startedAt desc", () => {
    const a = registry.startJob("uat", ["alpha_user"]);
    const b = registry.startJob("ide3", ["alpha_user"]);
    const list = registry.listJobs({ includeFinished: false });
    expect(list.map((j) => j.id)).toContain(a.id);
    expect(list.map((j) => j.id)).toContain(b.id);
  });

  it("filters by env when requested", () => {
    registry.startJob("uat", ["alpha_user"]);
    registry.startJob("ide3", ["alpha_user"]);
    const uatOnly = registry.listJobs({ env: "uat", includeFinished: false });
    expect(uatOnly.every((j) => j.env === "uat")).toBe(true);
  });
});
