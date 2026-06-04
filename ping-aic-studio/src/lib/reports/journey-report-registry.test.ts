import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createJourneyReportRegistry, JourneyJobConflictError } from "./journey-report-registry";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journey-reg-"));
}
const PARAMS = { from: "2026-06-03T00:00:00Z", to: "2026-06-04T00:00:00Z", maxEvents: 1000 };

describe("JourneyReportRegistry", () => {
  it("persists jobs and rejects a second active job for the same env", () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", PARAMS);
    expect(fs.existsSync(path.join(root, "prod", "journey-reports", ".jobs", `${job.id}.json`))).toBe(true);
    expect(() => reg.startJob("prod", PARAMS)).toThrow(JourneyJobConflictError);
    // A different env is fine.
    expect(() => reg.startJob("uat", PARAMS)).not.toThrow();
  });

  it("marks a non-terminal job 'interrupted' on reload, but leaves suspended/terminal alone", () => {
    const root = tmpRoot();
    const reg1 = createJourneyReportRegistry(root);
    const running = reg1.startJob("prod", PARAMS);
    reg1.setJobStatus(running.id, "running");
    const suspended = reg1.startJob("uat", PARAMS);
    reg1.setJobStatus(suspended.id, "suspended");
    const done = reg1.startJob("dev", PARAMS);
    reg1.setJobStatus(done.id, "completed");

    // New registry over the same dir simulates a restart.
    const reg2 = createJourneyReportRegistry(root);
    expect(reg2.getJob(running.id)!.status).toBe("interrupted");
    expect(reg2.getJob(suspended.id)!.status).toBe("suspended");
    expect(reg2.getJob(done.id)!.status).toBe("completed");
  });

  it("listJobs filters finished unless includeFinished", () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const a = reg.startJob("prod", PARAMS);
    reg.setJobStatus(a.id, "completed");
    const b = reg.startJob("prod", PARAMS); // active
    expect(reg.listJobs({ env: "prod", includeFinished: false }).map((j) => j.id)).toEqual([b.id]);
    expect(reg.listJobs({ env: "prod", includeFinished: true }).length).toBe(2);
  });
});
