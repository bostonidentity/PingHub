import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import type { LogJobStatus, LogPullJob, LogSourceProgress } from "./log-job-types";

const TERMINAL: LogJobStatus[] = ["completed", "failed", "aborted"];

export class LogJobConflictError extends Error {
    constructor(public existingJobId: string) {
        super(`Log pull already active for env (id=${existingJobId})`);
        this.name = "LogJobConflictError";
    }
}

export interface LogRegistry {
    startJob(env: string, sources: string[], from: string, to: string): LogPullJob;
    getJob(id: string): LogPullJob | undefined;
    getActiveJobForEnv(env: string): LogPullJob | undefined;
    listJobs(opts: { env?: string; includeFinished: boolean }): LogPullJob[];
    updateProgress(id: string, source: string, patch: Partial<LogSourceProgress>): void;
    setJobStatus(id: string, status: LogJobStatus, fatalError?: string): void;
}

function jobsDir(envsRoot: string, env: string): string {
    return path.join(envsRoot, env, "log-data", ".jobs");
}

function writeJobFile(envsRoot: string, job: LogPullJob): void {
    const dir = jobsDir(envsRoot, job.env);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${job.id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
    fs.renameSync(tmpPath, finalPath);
}

function isActive(j: LogPullJob): boolean {
    return !TERMINAL.includes(j.status);
}

export function createLogRegistry(envsRoot: string): LogRegistry {
    const byId = new Map<string, LogPullJob>();

    // Restart cleanup: load persisted jobs; mark non-terminal as interrupted so
    // a resume can pick up from each source's saved cookie. A user-suspended
    // job stays suspended.
    if (fs.existsSync(envsRoot)) {
        for (const envEntry of fs.readdirSync(envsRoot, { withFileTypes: true })) {
            if (!envEntry.isDirectory()) continue;
            const dir = jobsDir(envsRoot, envEntry.name);
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith(".json")) continue;
                try {
                    const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as LogPullJob;
                    if (isActive(job) && job.status !== "suspended") {
                        job.status = "interrupted";
                        writeJobFile(envsRoot, job);
                    }
                    byId.set(job.id, job);
                } catch { /* skip unreadable */ }
            }
        }
    }

    return {
        startJob(env, sources, from, to) {
            for (const j of byId.values()) {
                if (j.env === env && isActive(j)) throw new LogJobConflictError(j.id);
            }
            const job: LogPullJob = {
                id: randomUUID(),
                env,
                sources,
                from,
                to,
                startedAt: Date.now(),
                status: "queued",
                progress: sources.map((s) => ({ source: s, status: "pending", fetched: 0, stored: 0 })),
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
        updateProgress(id, source, patch) {
            const job = byId.get(id);
            if (!job) return;
            const p = job.progress.find((p) => p.source === source);
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

// Module-level singleton for API routes (Phase A2b). Stored on globalThis so it
// survives Next.js HMR in dev (a plain module var resets on hot-reload and would
// orphan in-flight runLogPull promises).
const _global = globalThis as typeof globalThis & { __logJobRegistry?: LogRegistry };
export function getLogRegistry(): LogRegistry {
    if (!_global.__logJobRegistry) _global.__logJobRegistry = createLogRegistry(ENVIRONMENTS_DIR);
    return _global.__logJobRegistry;
}
