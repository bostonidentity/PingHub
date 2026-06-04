"use client";

import { useEffect, useState, useCallback } from "react";
import type { LogPullJob } from "@/lib/logs/log-job-types";

export interface UseLogPullJobsOpts {
    pollMs?: number;
    includeFinished?: boolean;
    env?: string;
}

interface ActionResult {
    ok: boolean;
    status: number;
    body: { jobId?: string; status?: string; sources?: string[]; error?: string };
}

/** Poll the log-archive jobs endpoint and expose start/suspend/resume actions. */
export function useLogPullJobs(opts: UseLogPullJobsOpts = {}) {
    const { pollMs = 2000, includeFinished = true, env } = opts;
    const [jobs, setJobs] = useState<LogPullJob[]>([]);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const params = new URLSearchParams();
        if (env) params.set("env", env);
        if (includeFinished) params.set("includeFinished", "1");
        try {
            const res = await fetch(`/api/logs/archive/jobs?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { jobs: LogPullJob[] };
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

    const start = useCallback(async (startEnv: string, sources: string[], from: string, to: string): Promise<ActionResult> => {
        const res = await fetch("/api/logs/archive/pull", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ env: startEnv, sources, from, to }),
        });
        const body = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, status: res.status, body };
    }, [refresh]);

    const suspend = useCallback(async (id: string): Promise<ActionResult> => {
        const res = await fetch(`/api/logs/archive/jobs/${id}/suspend`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, status: res.status, body };
    }, [refresh]);

    const resume = useCallback(async (id: string): Promise<ActionResult> => {
        const res = await fetch(`/api/logs/archive/jobs/${id}/resume`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, status: res.status, body };
    }, [refresh]);

    const abort = useCallback(async (id: string): Promise<ActionResult> => {
        const res = await fetch(`/api/logs/archive/jobs/${id}`, { method: "DELETE" });
        const body = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, status: res.status, body };
    }, [refresh]);

    return { jobs, error, refresh, start, suspend, resume, abort };
}
