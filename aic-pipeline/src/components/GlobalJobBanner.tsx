"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";

// Polling strategy:
// - While idle (no active jobs), don't poll at all. One-shot check on mount
//   and whenever the tab regains focus (visibilitychange) is enough — a job
//   can only start from this browser anyway, and if one does the PullPanel's
//   own 2s poll catches it while we're on /data/pull.
// - As soon as a job appears, switch to 3s polling so the banner's count and
//   per-type progress stay reasonably live, then drop back to no-poll when it
//   finishes.
const ACTIVE_POLL_MS = 3_000;

export function GlobalJobBanner() {
  const [pollMs, setPollMs] = useState(0); // 0 = no interval; refresh() on demand
  const { jobs, refresh } = useDataPullJobs({ pollMs, includeFinished: false });
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "aborting");

  useEffect(() => {
    setPollMs(active.length > 0 ? ACTIVE_POLL_MS : 0);
  }, [active.length]);

  // One-shot re-check when the tab becomes visible again — catches jobs
  // started in other tabs without any background polling.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  if (active.length === 0) return null;

  const envs = active.map((j) => j.env).join(" · ");
  const label = `${active.length} data pull${active.length === 1 ? "" : "s"} in progress — ${envs}`;

  return (
    <Link
      href="/data/pull"
      className="block bg-amber-100 hover:bg-amber-200 border-b border-amber-300 text-amber-900 text-xs text-center py-1.5 transition-colors"
    >
      {label} · click to view
    </Link>
  );
}
