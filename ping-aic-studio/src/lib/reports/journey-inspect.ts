/** Drill-down window size — AIC rejects per-attempt queries spanning more than a day. */
export const INSPECT_WINDOW_HOURS = 24;

/**
 * Window for a per-attempt "inspect failures" drill-down: the most-recent
 * INSPECT_WINDOW_HOURS of a report's range (so the single-window, full-detail path
 * stays under AIC's 1-day query limit). A range already within the limit is returned
 * unchanged; a degenerate or unparseable range is echoed back so the caller still has
 * something runnable.
 */
export function buildInspectWindow(fromIso: string, toIso: string): { from: string; to: string } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { from: fromIso, to: toIso };
  }
  const start = Math.max(from, to - INSPECT_WINDOW_HOURS * 3_600_000);
  return { from: new Date(start).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Pre-flight guard: a single-window run (Window split = 0) sends the whole range as
 * ONE AIC query, which AIC rejects beyond a day. Returns a guidance message when the
 * range is too wide for that mode, or null when the run is fine (split > 0 chunks any
 * range; ≤ 1-day single-window is allowed).
 */
export function singleWindowTooWide(fromIso: string, toIso: string, windowHours: number | undefined): string | null {
  if (windowHours && windowHours > 0) return null; // chunked run handles any range
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const days = (to - from) / (INSPECT_WINDOW_HOURS * 3_600_000);
  if (days <= 1) return null;
  return `This ${Math.round(days)}-day range can't be pulled as a single AIC query (max 1 day). ` +
    `Set “Window split (hours)” to 24 for a multi-window rollup, or shorten the range to ≤ 1 day for full per-attempt detail.`;
}

/**
 * AIC retains journey (am-authentication) logs for a rolling ~30-day window — beyond
 * it, queries return HTTP 200 with zero results (no error). Confirmed empirically
 * against the prod tenant on 2026-06-08: data present at 29 days back, empty at 30+.
 */
export const JOURNEY_LOG_RETENTION_DAYS = 30;

/**
 * Warn when a query's `from` precedes AIC's rolling journey-log retention, so the
 * user knows the earliest part of the range will simply be empty (not an error).
 * Returns null when `from` is within retention or unparseable.
 */
export function retentionWarning(
  fromIso: string,
  nowMs: number,
  retentionDays: number = JOURNEY_LOG_RETENTION_DAYS,
): string | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  const earliest = nowMs - retentionDays * 24 * 3_600_000;
  if (from >= earliest) return null;
  const earliestDate = new Date(earliest).toISOString().slice(0, 10);
  return `AIC retains journey logs for only ~${retentionDays} days, so data before ${earliestDate} won’t exist — ` +
    `the earliest part of this range will come back empty.`;
}
