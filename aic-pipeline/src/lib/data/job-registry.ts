import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { DataPullJob, JobStatus, PerTypeProgress } from "./types";

const TERMINAL: JobStatus[] = ["completed", "failed", "aborted"];

export class JobConflictError extends Error {
  constructor(public existingJobId: string) {
    super(`Job already active for env (id=${existingJobId})`);
    this.name = "JobConflictError";
  }
}

export interface Registry {
  startJob(env: string, types: string[]): DataPullJob;
  getJob(id: string): DataPullJob | undefined;
  getActiveJobForEnv(env: string): DataPullJob | undefined;
  listJobs(opts: { env?: string; includeFinished: boolean }): DataPullJob[];
  updateProgress(id: string, type: string, patch: Partial<PerTypeProgress>): void;
  setJobStatus(id: string, status: JobStatus, fatalError?: string): void;
}

function jobsDir(envsRoot: string, env: string): string {
  return path.join(envsRoot, env, "managed-data", ".jobs");
}

function writeJobFile(envsRoot: string, job: DataPullJob): void {
  const dir = jobsDir(envsRoot, job.env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${job.id}.json`), JSON.stringify(job, null, 2));
}

function isActive(j: DataPullJob): boolean {
  return !TERMINAL.includes(j.status);
}

export function createRegistry(envsRoot: string): Registry {
  const byId = new Map<string, DataPullJob>();

  // Restart cleanup: load any persisted jobs; mark non-terminal ones failed.
  if (fs.existsSync(envsRoot)) {
    for (const envEntry of fs.readdirSync(envsRoot, { withFileTypes: true })) {
      if (!envEntry.isDirectory()) continue;
      const dir = jobsDir(envsRoot, envEntry.name);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as DataPullJob;
          if (isActive(job)) {
            job.status = "failed";
            job.fatalError = "server restart";
            job.finishedAt = Date.now();
            writeJobFile(envsRoot, job);
          }
          byId.set(job.id, job);
        } catch { /* skip */ }
      }
    }
  }

  return {
    startJob(env, types) {
      for (const j of byId.values()) {
        if (j.env === env && isActive(j)) throw new JobConflictError(j.id);
      }
      const job: DataPullJob = {
        id: randomUUID(),
        env,
        types,
        startedAt: Date.now(),
        status: "queued",
        progress: types.map((t) => ({
          type: t, status: "pending", fetched: 0, total: null,
        })),
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
    updateProgress(id, type, patch) {
      const job = byId.get(id);
      if (!job) return;
      const p = job.progress.find((p) => p.type === type);
      if (!p) return;
      Object.assign(p, patch);
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
  };
}

// Module-level singleton used by API routes.
// Points at the real environments/ root.
// Stored on globalThis so it survives Next.js HMR in dev mode; a plain
// module-level variable is reset on every hot-reload, which orphans
// in-flight runPull promises and can leave jobs stuck as "running".
import { cwd } from "process";
const _global = globalThis as typeof globalThis & { __dataJobRegistry?: Registry };
export function getRegistry(): Registry {
  if (!_global.__dataJobRegistry) _global.__dataJobRegistry = createRegistry(path.join(cwd(), "environments"));
  return _global.__dataJobRegistry;
}
