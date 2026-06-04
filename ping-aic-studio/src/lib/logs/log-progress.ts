// Progress for a log pull can't be a count ratio — you don't know how many
// events a time window holds until you've pulled them. But logs arrive in
// ascending timestamp order, so how far the most-recent stored event has
// advanced through [from, to] IS a real, monotonic, bounded progress signal.
//
// Caveat: this assumes events are roughly uniform in time. A burst means the
// estimate lags reality, but it never goes backward and always lands at 1.0 —
// exactly what a progress bar needs. Label it "time window covered", not
// "records done".

export type LogSourceStatus = "pending" | "running" | "done" | "failed";

/**
 * Fraction (0..1) of the [from, to] window covered by a source, or null when
 * it can't be determined (running/failed with no event yet, or bad timestamps)
 * — in which case the caller should show an indeterminate bar.
 */
export function timeCoverageFraction(
  from: string,
  to: string,
  lastTimestamp: string | undefined,
  status: LogSourceStatus,
): number | null {
  if (status === "done") return 1;       // cookie exhausted → window fully pulled
  if (status === "pending") return 0;     // not started
  // running | failed: progress is how far the last stored event reached.
  if (!lastTimestamp) return status === "failed" ? null : 0;
  const f = Date.parse(from);
  const t = Date.parse(to);
  const l = Date.parse(lastTimestamp);
  if (!Number.isFinite(f) || !Number.isFinite(t) || !Number.isFinite(l) || t <= f) return null;
  return Math.min(1, Math.max(0, (l - f) / (t - f)));
}
