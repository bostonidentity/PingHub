"use client";

import Link from "next/link";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";

export function GlobalJobBanner() {
  const { jobs } = useDataPullJobs({ pollMs: 3000, includeFinished: false });
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "aborting");
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
