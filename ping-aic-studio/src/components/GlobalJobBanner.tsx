"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";
import { useLogPullJobs } from "@/hooks/useLogPullJobs";
import type { DataPullJob } from "@/lib/data/types";
import type { LogPullJob } from "@/lib/logs/log-job-types";

// Polling strategy:
// - While idle (no active jobs), don't poll at all. One-shot check on mount
//   and whenever the tab regains focus (visibilitychange) is enough — a job
//   can only start from this browser anyway, and if one does the pull view's
//   own 2s poll catches it while we're on /data/pull.
// - As soon as any job appears, switch to 3s polling so the banner's count
//   stays reasonably live, then drop back to no-poll when it finishes.
const ACTIVE_POLL_MS = 3_000;

// "In progress" = actively working. Paused states (suspended/interrupted) and
// terminal states are intentionally excluded.
const ACTIVE = new Set(["running", "queued", "aborting"]);

const uniqEnvs = (jobs: { env: string }[]): string =>
  [...new Set(jobs.map((j) => j.env))].join(", ");

// Live one-line summaries with cumulative counts + unit completion. Counts sum
// across every active job of the type, so two pulls on different envs roll up.
function dataSummary(jobs: DataPullJob[]): string {
  const records = jobs.reduce((a, j) => a + j.progress.reduce((b, p) => b + p.fetched, 0), 0);
  const done = jobs.reduce((a, j) => a + j.progress.filter((p) => p.status === "done").length, 0);
  const units = jobs.reduce((a, j) => a + j.progress.length, 0);
  const head = `${jobs.length > 1 ? `${jobs.length} ` : ""}managed-object pull${jobs.length === 1 ? "" : "s"}`;
  return `${head} · ${records.toLocaleString()} records${units ? ` (${done}/${units} types)` : ""} — ${uniqEnvs(jobs)}`;
}

function logSummary(jobs: LogPullJob[]): string {
  const events = jobs.reduce((a, j) => a + j.progress.reduce((b, p) => b + p.stored, 0), 0);
  const done = jobs.reduce((a, j) => a + j.progress.filter((p) => p.status === "done").length, 0);
  const units = jobs.reduce((a, j) => a + j.progress.length, 0);
  const head = `${jobs.length > 1 ? `${jobs.length} ` : ""}log pull${jobs.length === 1 ? "" : "s"}`;
  return `${head} · ${events.toLocaleString()} events${units ? ` (${done}/${units} sources)` : ""} — ${uniqEnvs(jobs)}`;
}

export function GlobalJobBanner() {
  const [pollMs, setPollMs] = useState(0); // 0 = no interval; refresh() on demand
  const { jobs: dataJobs, refresh: refreshData } = useDataPullJobs({ pollMs, includeFinished: false });
  const { jobs: logJobs, refresh: refreshLogs } = useLogPullJobs({ pollMs, includeFinished: false });

  const activeData = dataJobs.filter((j) => ACTIVE.has(j.status));
  const activeLogs = logJobs.filter((j) => ACTIVE.has(j.status));
  const total = activeData.length + activeLogs.length;

  useEffect(() => {
    setPollMs(total > 0 ? ACTIVE_POLL_MS : 0);
  }, [total]);

  // One-shot re-check when the tab becomes visible again — catches jobs
  // started in other tabs without any background polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") { refreshData(); refreshLogs(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshData, refreshLogs]);

  if (total === 0) return null;

  // Per-type live summaries so a managed-object pull and a log pull running at
  // the same time are each named with their own counts and env.
  const parts: string[] = [];
  if (activeData.length) parts.push(dataSummary(activeData));
  if (activeLogs.length) parts.push(logSummary(activeLogs));
  const label = parts.join("  ·  ");

  // Land on the view that actually has work. When only log pulls are running,
  // deep-link to the Logs sub-view; otherwise default to managed objects.
  const href = activeData.length === 0 && activeLogs.length > 0
    ? "/data/pull?mode=logs"
    : "/data/pull";

  return (
    <Link
      href={href}
      className="block bg-amber-100 hover:bg-amber-200 border-b border-amber-300 text-amber-900 text-xs text-center py-1.5 transition-colors"
    >
      {label} <span className="opacity-70">· click to view</span>
    </Link>
  );
}
