import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogRegistry, LogJobConflictError } from "./log-job-registry";

function tmpEnvsRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-jobs-"));
}

const WINDOW = { from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" };

describe("log-job-registry", () => {
    it("startJob creates a job with per-source pending progress and persists it", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication", "am-access"], WINDOW.from, WINDOW.to);
        expect(job.status).toBe("queued");
        expect(job.from).toBe(WINDOW.from);
        expect(job.progress.map((p) => p.source)).toEqual(["am-authentication", "am-access"]);
        expect(job.progress.every((p) => p.status === "pending" && p.fetched === 0 && p.stored === 0)).toBe(true);
        // Persisted to disk under {env}/log-data/.jobs/{id}.json
        const f = path.join(root, "prod", "log-data", ".jobs", `${job.id}.json`);
        expect(fs.existsSync(f)).toBe(true);
    });

    it("rejects a second active job for the same env", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        expect(() => reg.startJob("prod", ["am-access"], WINDOW.from, WINDOW.to)).toThrow(LogJobConflictError);
    });

    it("allows a new job once the prior one is terminal", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const a = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.setJobStatus(a.id, "completed");
        expect(() => reg.startJob("prod", ["am-access"], WINDOW.from, WINDOW.to)).not.toThrow();
    });

    it("updateProgress patches a source and persists", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.updateProgress(job.id, "am-authentication", { status: "running", fetched: 100, stored: 90, cookie: "c1" });
        const reloaded = JSON.parse(
            fs.readFileSync(path.join(root, "prod", "log-data", ".jobs", `${job.id}.json`), "utf-8"),
        );
        expect(reloaded.progress[0]).toMatchObject({ status: "running", fetched: 100, stored: 90, cookie: "c1" });
    });

    it("setJobStatus to terminal stamps finishedAt", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.setJobStatus(job.id, "failed", "boom");
        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("failed");
        expect(j.fatalError).toBe("boom");
        expect(typeof j.finishedAt).toBe("number");
    });

    it("on construction, marks a persisted non-terminal job as interrupted (but leaves suspended)", () => {
        const root = tmpEnvsRoot();
        const reg1 = createLogRegistry(root);
        const running = reg1.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg1.setJobStatus(running.id, "running");
        const suspended = reg1.startJob("uat", ["am-access"], WINDOW.from, WINDOW.to);
        reg1.setJobStatus(suspended.id, "suspended");

        // Simulate a server restart: a fresh registry over the same root.
        const reg2 = createLogRegistry(root);
        expect(reg2.getJob(running.id)!.status).toBe("interrupted");
        expect(reg2.getJob(suspended.id)!.status).toBe("suspended");
    });

    it("getActiveJobForEnv returns undefined once the job is terminal", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        expect(reg.getActiveJobForEnv("prod")?.id).toBe(job.id);
        reg.setJobStatus(job.id, "completed");
        expect(reg.getActiveJobForEnv("prod")).toBeUndefined();
    });

    it("listJobs filters by env and respects includeFinished", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const prod = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.startJob("uat", ["am-access"], WINDOW.from, WINDOW.to);
        reg.setJobStatus(prod.id, "completed");

        expect(reg.listJobs({ env: "prod", includeFinished: false })).toHaveLength(0);
        expect(reg.listJobs({ env: "prod", includeFinished: true }).map((j) => j.id)).toEqual([prod.id]);
        expect(reg.listJobs({ includeFinished: true })).toHaveLength(2);
    });

    it("updateProgress is a no-op for an unknown id or source", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        expect(() => reg.updateProgress("does-not-exist", "am-authentication", { fetched: 1 })).not.toThrow();
        expect(() => reg.updateProgress(job.id, "no-such-source", { fetched: 1 })).not.toThrow();
        expect(reg.getJob(job.id)!.progress[0].fetched).toBe(0); // unchanged
    });
});
