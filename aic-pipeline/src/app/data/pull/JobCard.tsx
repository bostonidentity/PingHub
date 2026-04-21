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

function timeAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ms).toLocaleTimeString();
}

export function JobCard({ job, onAbort }: { job: DataPullJob; onAbort: () => void }) {
  const canAbort = job.status === "running" || job.status === "queued";
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-slate-500">{job.env}</span>
        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold rounded", STATUS_STYLE[job.status])}>
          {job.status}
        </span>
        <span className="text-xs text-slate-500">started {timeAgo(job.startedAt)}</span>
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
          const pct = p.total ? Math.min(100, Math.round((p.fetched / p.total) * 100)) : null;
          return (
            <div key={p.type} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-slate-700 w-40 truncate">{p.type}</span>
              <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
                {pct !== null && (
                  <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                )}
              </div>
              <span className="text-slate-500 tabular-nums w-28 text-right">
                {p.fetched}{p.total != null ? ` / ${p.total}` : ""}
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
