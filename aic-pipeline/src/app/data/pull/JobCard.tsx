// src/app/data/pull/JobCard.tsx
"use client";

import type { DataPullJob } from "@/lib/data/types";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<DataPullJob["status"], string> = {
  queued:     "bg-slate-100 text-slate-600",
  running:    "bg-sky-100 text-sky-700",
  aborting:   "bg-amber-100 text-amber-700",
  completed:  "bg-emerald-100 text-emerald-700",
  failed:     "bg-rose-100 text-rose-700",
  aborted:    "bg-slate-100 text-slate-500",
};

const MIN_ELAPSED_FOR_ETA_MS = 10_000;

function timeAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ms).toLocaleTimeString();
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

/**
 * Resolve the denominator for a type's progress. Prefer the server-side total
 * (set by the pull-runner preflight); fall back to a user-probed count
 * (collected via the "Probe counts" button and stored in localStorage), which
 * is the only source for tenants that reject _countPolicy. null means we
 * genuinely don't know how many records are expected.
 */
function expectedFor(pTotal: number | null, probed: number | null | undefined): number | null {
  if (typeof pTotal === "number" && pTotal >= 0) return pTotal;
  if (typeof probed === "number" && probed >= 0) return probed;
  return null;
}

export function JobCard({
  job,
  probedCounts = {},
  onAbort,
}: {
  job: DataPullJob;
  probedCounts?: Record<string, number | null>;
  onAbort: () => void;
}) {
  const canAbort = job.status === "running" || job.status === "queued";
  const isRunning = job.status === "running" || job.status === "queued" || job.status === "aborting";
  const elapsedMs = Date.now() - job.startedAt;

  // Aggregate progress across types for the header ETA. We only display an ETA
  // when every per-type expected is known — otherwise a partial total would
  // underestimate and mislead.
  let totalFetched = 0;
  let totalExpected = 0;
  let anyUnknown = false;
  for (const p of job.progress) {
    totalFetched += p.fetched;
    const exp = expectedFor(p.total, probedCounts[p.type]);
    if (exp === null) anyUnknown = true;
    else totalExpected += exp;
  }
  const etaMs = (
    isRunning
    && !anyUnknown
    && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS
    && totalFetched > 0
    && totalExpected > totalFetched
  )
    ? Math.round((totalExpected - totalFetched) * (elapsedMs / totalFetched))
    : null;
  const ratePerSec = isRunning && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS && totalFetched > 0
    ? totalFetched / (elapsedMs / 1000)
    : null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-xs text-slate-500">{job.env}</span>
        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold rounded", STATUS_STYLE[job.status])}>
          {job.status}
        </span>
        <span className="text-xs text-slate-500">started {timeAgo(job.startedAt)}</span>
        {etaMs !== null && (
          <span
            className="text-xs text-sky-700"
            title={ratePerSec ? `${Math.round(ratePerSec).toLocaleString()} records/sec` : undefined}
          >
            · ~{formatDuration(etaMs)} remaining
          </span>
        )}
        {canAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="ml-auto px-2 py-0.5 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
          >Abort</button>
        )}
        {job.fatalError && <span className="ml-auto text-xs text-rose-600">{job.fatalError}</span>}
      </div>
      <div className="space-y-1">
        {job.progress.map((p) => {
          const expected = expectedFor(p.total, probedCounts[p.type]);
          const pct = expected !== null && expected > 0
            ? Math.min(100, Math.round((p.fetched / expected) * 100))
            : null;
          const denomFromProbe = (p.total === null || p.total === undefined) && expected !== null;
          return (
            <div key={p.type} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-slate-700 w-40 truncate">{p.type}</span>
              <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
                {pct !== null && (
                  <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                )}
              </div>
              <span
                className="text-slate-500 tabular-nums w-28 text-right"
                title={denomFromProbe ? "Denominator from the Probe counts value" : undefined}
              >
                {p.fetched.toLocaleString()}
                {expected !== null ? ` / ${expected.toLocaleString()}${denomFromProbe ? "*" : ""}` : ""}
              </span>
              <span className={cn("text-[10px] w-16", p.status === "failed" ? "text-rose-600" : "text-slate-400")}>
                {p.status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
