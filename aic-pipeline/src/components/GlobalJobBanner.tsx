"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";

// Adaptive polling: the banner is mounted globally and doesn't need to be
// eagerly polling when nothing is happening. Once any job is active, speed
// up so the banner (and its count) stay reasonably live.
const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 3_000;

export function GlobalJobBanner() {
  const [pollMs, setPollMs] = useState(IDLE_POLL_MS);
  const { jobs } = useDataPullJobs({ pollMs, includeFinished: false });
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "aborting");

  useEffect(() => {
    setPollMs(active.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }, [active.length]);

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
