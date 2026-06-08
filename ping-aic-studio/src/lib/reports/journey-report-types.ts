// Background-job model for the live Journey-history report — mirrors the log
// pull job (resumable, persisted, one active per env) so a 429-throttled report
// retries, runs in the background, and can be suspended/resumed.

import type { JourneyHistoryReport } from "./journey-history";

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
  /** Exact journey names to include (empty = all). Server-side filters the AIC
   * pull when small; analysis-time set filter for archive / large selections. */
  treeNames?: string[];
  /** Cap on matched journey events staged. */
  maxEvents: number;
  /**
   * Pull only the two AM-TREE-LOGIN-* events (journey success/fail rates),
   * dropping the high-volume AM-NODE-LOGIN-COMPLETED events server-side.
   * Far fewer events per page → fewer pages, less throttling, much faster — at
   * the cost of per-node failure attribution (top failure nodes go empty).
   */
  summaryOnly?: boolean;
  /**
   * Split [from, to] into windows of this many HOURS and pull/analyze each one
   * in turn, merging the per-journey rollups. AIC's /monitoring/logs rejects any
   * query spanning more than a day, so a long range MUST be chunked into ≤ 24h
   * windows. Also keeps each window under the per-request page/event caps and
   * bounds memory to one window at a time. 0/undefined or a range that fits one
   * window → single-window behavior (full per-attempt report). Multi-window runs
   * emit a rollup-only report.
   */
  windowHours?: number;
  /**
   * Max windows paged concurrently in a chunked run. AIC throttles bursts above
   * ~6 concurrent /monitoring/logs queries, so this is clamped to [1, 6]
   * (default 4). 1 = sequential.
   */
  windowConcurrency?: number;
  /**
   * Minimum delay (ms) between page requests within a window. Default 5000.
   * Header-based pacing and the adaptive 429 backoff stack on top of this floor.
   */
  requestDelayMs?: number;
}

/** Accumulator persisted across windows of a chunked (multi-window) run. */
export interface JourneyReportPartial {
  /** Merged journey rollup over all completed windows. */
  rollup: Pick<JourneyHistoryReport, "summary" | "perJourney">;
  /** Cumulative event-name tally across completed windows (for "top event names"). */
  eventNameCounts: Record<string, number>;
  rawTotal: number;
  matchedTotal: number;
  pagesTotal: number;
  /** Any window hit a page/event cap → the merged report is incomplete. */
  anyTruncated: boolean;
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
  /** Chunked runs: index of the window currently being paged (0-based). @deprecated superseded by completedWindows. */
  windowIndex?: number;
  /** Chunked runs: total number of windows. >1 means a multi-window (rollup-only) run. */
  windowsTotal?: number;
  /** Chunked runs: indices of windows already paged + folded into `partial`; resume skips them. */
  completedWindows?: number[];
  /** Chunked runs: count of completed windows (for progress display). */
  windowsDone?: number;
  /** Chunked runs: merged rollup + cumulative tallies for windows already finalized. */
  partial?: JourneyReportPartial;
  /** Most-recent matched events, surfaced live to the UI feed. */
  recentEvents?: { ts: string; eventName: string; tree?: string }[];
  /** Cumulative count of 429 throttles auto-retried during this job. */
  throttles?: number;
  /** True while the run is *actively* being throttled (drives the live banner); clears once pages flow cleanly again. */
  throttling?: boolean;
  /** Backoff (ms) of the most recent 429 retry. */
  lastThrottleWaitMs?: number;
  /** Retry attempt number of the most recent 429 (1..maxRetries). */
  lastThrottleAttempt?: number;
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
