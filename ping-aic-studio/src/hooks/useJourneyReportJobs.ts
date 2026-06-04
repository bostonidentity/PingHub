"use client";

import { useEffect, useState, useCallback } from "react";
import type { JourneyReportJob, JourneyReportParams } from "@/lib/reports/journey-report-types";

export interface UseJourneyReportJobsOpts {
  pollMs?: number;
  includeFinished?: boolean;
  env?: string;
}

interface ActionResult {
  ok: boolean;
  status: number;
  body: { jobId?: string; status?: string; error?: string };
}

/** Poll the journey-report jobs endpoint and expose start/suspend/resume/abort + report fetch. */
export function useJourneyReportJobs(opts: UseJourneyReportJobsOpts = {}) {
  const { pollMs = 2000, includeFinished = true, env } = opts;
  const [jobs, setJobs] = useState<JourneyReportJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (env) params.set("env", env);
    if (includeFinished) params.set("includeFinished", "1");
    try {
      const res = await fetch(`/api/analyze/journey-history/jobs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: JourneyReportJob[] };
      setJobs(data.jobs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [env, includeFinished]);

  useEffect(() => {
    refresh();
    if (pollMs <= 0) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const start = useCallback(async (startEnv: string, params: JourneyReportParams): Promise<ActionResult> => {
    const res = await fetch("/api/analyze/journey-history/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: startEnv, ...params }),
    });
    const body = await res.json().catch(() => ({}));
    await refresh();
    return { ok: res.ok, status: res.status, body };
  }, [refresh]);

  const suspend = useCallback(async (id: string): Promise<ActionResult> => {
    const res = await fetch(`/api/analyze/journey-history/jobs/${id}/suspend`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    await refresh();
    return { ok: res.ok, status: res.status, body };
  }, [refresh]);

  const resume = useCallback(async (id: string): Promise<ActionResult> => {
    const res = await fetch(`/api/analyze/journey-history/jobs/${id}/resume`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    await refresh();
    return { ok: res.ok, status: res.status, body };
  }, [refresh]);

  const abort = useCallback(async (id: string): Promise<ActionResult> => {
    const res = await fetch(`/api/analyze/journey-history/jobs/${id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    await refresh();
    return { ok: res.ok, status: res.status, body };
  }, [refresh]);

  /** Fetch the finished report JSON for a completed job. */
  const fetchReport = useCallback(async (id: string): Promise<unknown | null> => {
    const res = await fetch(`/api/analyze/journey-history/jobs/${id}/report`);
    if (!res.ok) return null;
    return res.json();
  }, []);

  return { jobs, error, refresh, start, suspend, resume, abort, fetchReport };
}
