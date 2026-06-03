export type LogJobStatus =
    | "queued"
    | "running"
    | "aborting"
    | "completed"
    | "failed"
    | "aborted"
    | "interrupted"
    | "suspending"
    | "suspended";

export interface LogSourceProgress {
    source: string;
    status: "pending" | "running" | "done" | "failed";
    /** Raw entries pulled from AIC for this source (cumulative across resumes). */
    fetched: number;
    /** Newly stored (deduped) entries for this source (cumulative). */
    stored: number;
    /** Last persisted pagedResultsCookie. null = source exhausted; undefined = not started. */
    cookie?: string | null;
    error?: string;
}

export interface LogPullJob {
    id: string;
    env: string;
    sources: string[];
    /** ISO window pulled for every source in this job. */
    from: string;
    to: string;
    startedAt: number;
    finishedAt?: number;
    status: LogJobStatus;
    progress: LogSourceProgress[];
    fatalError?: string;
}
