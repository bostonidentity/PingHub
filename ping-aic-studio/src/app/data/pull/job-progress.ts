import type { JobCardRow } from "./JobCard";

/**
 * The 0..1 progress fraction for a single row's bar, in priority order:
 * done → full, explicit coverage (logs, time-based), count ratio (managed),
 * else null (unknown → indeterminate).
 */
export function rowFraction(p: Pick<JobCardRow, "status" | "coverage" | "expected" | "fetched">): number | null {
  if (p.status === "done") return 1;
  if (p.coverage != null) return Math.min(1, Math.max(0, p.coverage));
  if (p.expected !== null && p.expected > 0) return Math.min(1, p.fetched / p.expected);
  return null;
}

export interface Overall {
  /** 0..100, or null when there's nothing to show. */
  pct: number | null;
  /** Σ of the headline count (records for managed, stored events for logs). */
  count: number;
  doneUnits: number;
  totalUnits: number;
  /** False when the % is a coarse done-ratio fallback (managed with an unknown total). */
  exact: boolean;
}

/**
 * Aggregate a job's rows into one overall figure.
 * - logs: mean of per-source time-coverage (no counts to weight by).
 * - managed, all totals known: Σfetched/Σtotal (count-weighted).
 * - managed, any total unknown: done/total units (coarse, marked `exact:false`).
 */
export function computeOverall(kind: "managed" | "logs", rows: JobCardRow[]): Overall {
  const totalUnits = rows.length;
  const doneUnits = rows.filter((r) => r.status === "done").length;
  const count = rows.reduce((a, r) => a + r.fetched, 0);
  if (totalUnits === 0) return { pct: null, count, doneUnits, totalUnits, exact: true };

  if (kind === "logs") {
    const sum = rows.reduce((a, r) => a + (rowFraction(r) ?? 0), 0);
    return { pct: Math.round((sum / totalUnits) * 100), count, doneUnits, totalUnits, exact: true };
  }

  const allKnown = rows.every((r) => r.expected !== null);
  if (allKnown) {
    const tot = rows.reduce((a, r) => a + (r.expected ?? 0), 0);
    const got = rows.reduce((a, r) => a + (rowFraction(r) ?? 0) * (r.expected ?? 0), 0);
    const pct = tot > 0 ? Math.round((got / tot) * 100) : (doneUnits === totalUnits ? 100 : 0);
    return { pct, count, doneUnits, totalUnits, exact: true };
  }
  // A total is unknown → no honest count %. Fall back to units completed.
  return { pct: Math.round((doneUnits / totalUnits) * 100), count, doneUnits, totalUnits, exact: false };
}
