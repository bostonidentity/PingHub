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
