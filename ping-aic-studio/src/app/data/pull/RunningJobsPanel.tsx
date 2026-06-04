"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";
import { useLogPullJobs } from "@/hooks/useLogPullJobs";
import { cn } from "@/lib/utils";
import { focusJob } from "./job-focus";
import type { DataPullJob } from "@/lib/data/types";
import type { LogPullJob } from "@/lib/logs/log-job-types";

const POLL_MS = 3_000;

// Same palette as the per-env JobCard, limited to the non-terminal statuses
// this panel can show. Unknown statuses fall back to a neutral slate pill.
const STATUS_STYLE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  aborting: "bg-amber-100 text-amber-700",
  interrupted: "bg-amber-100 text-amber-800",
  suspending: "bg-indigo-100 text-indigo-700",
  suspended: "bg-indigo-100 text-indigo-800",
};

type Row =
  | { kind: "managed"; job: DataPullJob }
  | { kind: "logs"; job: LogPullJob };

function managedProgress(job: DataPullJob): string {
  const records = job.progress.reduce((a, p) => a + p.fetched, 0);
  const done = job.progress.filter((p) => p.status === "done").length;
  return `${records.toLocaleString()} records · ${done}/${job.progress.length} types`;
}

function logProgress(job: LogPullJob): string {
  const events = job.progress.reduce((a, p) => a + p.stored, 0);
  const done = job.progress.filter((p) => p.status === "done").length;
  return `${events.toLocaleString()} events · ${done}/${job.progress.length} sources`;
}

/**
 * Compact overview of every unfinished pull job (managed-object + log) across
 * all environments. Polls both job endpoints; `includeFinished: false` returns
 * exactly the non-terminal jobs — running, queued, aborting, suspending,
 * suspended, and interrupted. Collapsible; hides itself when nothing is running.
 */
export function RunningJobsPanel() {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const { jobs: dataJobs } = useDataPullJobs({ pollMs: POLL_MS, includeFinished: false });
  const { jobs: logJobs } = useLogPullJobs({ pollMs: POLL_MS, includeFinished: false });

  // Record the target so the Pull page lands on the right view/env and scrolls
  // to the job, then navigate (a no-op if we're already on /data/pull).
  const go = (row: Row) => {
    focusJob({ mode: row.kind, env: row.job.env, jobId: row.job.id });
    router.push("/data/pull");
  };

  const rows: Row[] = [
    ...dataJobs.map((job): Row => ({ kind: "managed", job })),
    ...logJobs.map((job): Row => ({ kind: "logs", job })),
  ].sort((a, b) => b.job.startedAt - a.job.startedAt);

  if (rows.length === 0) return null;

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-lg"
      >
        {collapsed ? <ChevronRight className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        <span>Unfinished jobs</span>
        <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">
          {rows.length}
        </span>
        <span className="ml-auto text-xs font-normal text-slate-400">all environments</span>
      </button>

      {!collapsed && (
        <ul className="divide-y divide-slate-100 border-t border-slate-200">
          {rows.map((row) => {
            const { kind, job } = row;
            return (
              <li key={`${kind}:${job.id}`}>
                <button
                  type="button"
                  onClick={() => go(row)}
                  title="Go to this job"
                  className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-indigo-50/60 transition-colors"
                >
                  <span
                    className={cn(
                      "shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                      kind === "managed" ? "bg-sky-50 text-sky-700" : "bg-violet-50 text-violet-700",
                    )}
                  >
                    {kind === "managed" ? "Managed" : "Logs"}
                  </span>
                  <span className="shrink-0 font-medium text-slate-800">{job.env}</span>
                  <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px]", STATUS_STYLE[job.status] ?? "bg-slate-100 text-slate-600")}>
                    {job.status}
                  </span>
                  <span className="truncate text-xs text-slate-500">
                    {kind === "managed" ? managedProgress(job) : logProgress(job)}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                    started {new Date(job.startedAt).toLocaleTimeString()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
