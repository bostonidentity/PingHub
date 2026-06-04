// Background-job model for the live Journey-history report — mirrors the log
// pull job (resumable, persisted, one active per env) so a 429-throttled report
// retries, runs in the background, and can be suspended/resumed.

export type JourneyReportStatus =
  | "queued"
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  | "suspending"
  | "suspended";

export interface JourneyReportParams {
  /** ISO window. */
  from: string;
  to: string;
  /** Optional treeName substring filter (applied at analysis time). */
  treeName?: string;
  /** Cap on matched journey events staged. */
  maxEvents: number;
}

export interface JourneyReportProgress {
  /** Pages fetched from AIC so far. */
  page: number;
  /** Raw events returned by AIC (cumulative). */
  rawFetched: number;
  /** Matched journey events staged to disk (cumulative). */
  matched: number;
  /** Last persisted pagedResultsCookie. null = source exhausted; undefined = not started. */
  cookie?: string | null;
  /** Bytes written to the staging NDJSON when `cookie` was persisted — truncate the half-written tail on resume. */
  byteLength?: number;
  /** Timestamp of the most-recent staged event (live progress display). */
  lastTimestamp?: string;
  /** Hit the maxEvents cap (or page safety cap). */
  truncated?: boolean;
  /** Running tally of every event name seen — preserves "top event names" across resumes. */
  eventNameCounts?: Record<string, number>;
}

export interface JourneyReportJob {
  id: string;
  env: string;
  params: JourneyReportParams;
  startedAt: number;
  finishedAt?: number;
  status: JourneyReportStatus;
  progress: JourneyReportProgress;
  /** The analyzed report has been written to disk and can be fetched. */
  reportReady?: boolean;
  fatalError?: string;
}
