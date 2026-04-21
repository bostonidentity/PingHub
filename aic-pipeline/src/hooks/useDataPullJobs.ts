"use client";

import { useEffect, useState, useCallback } from "react";
import type { DataPullJob } from "@/lib/data/types";

export interface UseDataPullJobsOpts {
  pollMs?: number;
  includeFinished?: boolean;
  env?: string;
}

export function useDataPullJobs(opts: UseDataPullJobsOpts = {}) {
  const { pollMs = 2000, includeFinished = true, env } = opts;
  const [jobs, setJobs] = useState<DataPullJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (env) params.set("env", env);
    if (!includeFinished) params.set("includeFinished", "false");
    try {
      const res = await fetch(`/api/data/jobs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { jobs: DataPullJob[] };
      setJobs(data.jobs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [env, includeFinished]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const abort = useCallback(async (id: string) => {
    await fetch(`/api/data/jobs/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const start = useCallback(async (startEnv: string, types: string[]) => {
    const res = await fetch("/api/data/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: startEnv, types }),
    });
    const data = await res.json();
    await refresh();
    return { ok: res.ok, status: res.status, body: data as { jobId?: string; status?: string; error?: string } };
  }, [refresh]);

  return { jobs, error, refresh, abort, start };
}
