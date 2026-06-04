import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import type { JourneyReportStatus, JourneyReportJob, JourneyReportProgress, JourneyReportParams } from "./journey-report-types";

const TERMINAL: JourneyReportStatus[] = ["completed", "failed", "aborted"];

export class JourneyJobConflictError extends Error {
  constructor(public existingJobId: string) {
    super(`Journey report already active for env (id=${existingJobId})`);
    this.name = "JourneyJobConflictError";
  }
}

export interface JourneyReportRegistry {
  startJob(env: string, params: JourneyReportParams): JourneyReportJob;
  getJob(id: string): JourneyReportJob | undefined;
  getActiveJobForEnv(env: string): JourneyReportJob | undefined;
  listJobs(opts: { env?: string; includeFinished: boolean }): JourneyReportJob[];
  updateProgress(id: string, patch: Partial<JourneyReportProgress>): void;
  setJobStatus(id: string, status: JourneyReportStatus, fatalError?: string): void;
  markReportReady(id: string): void;
}

function jobsDir(envsRoot: string, env: string): string {
  return path.join(envsRoot, env, "journey-reports", ".jobs");
}

function writeJobFile(envsRoot: string, job: JourneyReportJob): void {
  const dir = jobsDir(envsRoot, job.env);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${job.id}.json`);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

function isActive(j: JourneyReportJob): boolean {
  return !TERMINAL.includes(j.status);
}

export function createJourneyReportRegistry(envsRoot: string): JourneyReportRegistry {
  const byId = new Map<string, JourneyReportJob>();

  // Restart cleanup: load persisted jobs; a job left non-terminal when the
  // process died becomes "interrupted" so a resume continues from its cookie.
  // A user-suspended job stays "suspended".
  if (fs.existsSync(envsRoot)) {
    for (const envEntry of fs.readdirSync(envsRoot, { withFileTypes: true })) {
      if (!envEntry.isDirectory()) continue;
      const dir = jobsDir(envsRoot, envEntry.name);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as JourneyReportJob;
          if (job.status !== "suspended" && isActive(job)) {
            job.status = "interrupted";
          }
          byId.set(job.id, job);
        } catch { /* skip unreadable */ }
      }
    }
  }

  return {
    startJob(env, params) {
      for (const j of byId.values()) {
        if (j.env === env && isActive(j)) throw new JourneyJobConflictError(j.id);
      }
      const job: JourneyReportJob = {
        id: randomUUID(),
        env,
        params,
        startedAt: Date.now(),
        status: "queued",
        progress: { page: 0, rawFetched: 0, matched: 0 },
      };
      byId.set(job.id, job);
      writeJobFile(envsRoot, job);
      return job;
    },
    getJob(id) { return byId.get(id); },
    getActiveJobForEnv(env) {
      for (const j of byId.values()) {
        if (j.env === env && isActive(j)) return j;
      }
      return undefined;
    },
    listJobs({ env, includeFinished }) {
      return [...byId.values()]
        .filter((j) => (env ? j.env === env : true))
        .filter((j) => (includeFinished ? true : isActive(j)))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 20);
    },
    updateProgress(id, patch) {
      const job = byId.get(id);
      if (!job) return;
      job.progress = { ...job.progress, ...patch };
      writeJobFile(envsRoot, job);
    },
    setJobStatus(id, status, fatalError) {
      const job = byId.get(id);
      if (!job) return;
      job.status = status;
      if (fatalError) job.fatalError = fatalError;
      if (TERMINAL.includes(status)) job.finishedAt = Date.now();
      writeJobFile(envsRoot, job);
    },
    markReportReady(id) {
      const job = byId.get(id);
      if (!job) return;
      job.reportReady = true;
      writeJobFile(envsRoot, job);
    },
  };
}

// Singleton on globalThis so it survives Next.js HMR (a plain module var resets
// on hot-reload and would orphan in-flight runJourneyReport promises).
const _global = globalThis as typeof globalThis & { __journeyReportRegistry?: JourneyReportRegistry };
export function getJourneyReportRegistry(): JourneyReportRegistry {
  if (!_global.__journeyReportRegistry) _global.__journeyReportRegistry = createJourneyReportRegistry(ENVIRONMENTS_DIR);
  return _global.__journeyReportRegistry;
}
