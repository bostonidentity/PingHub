"use client";

import { useEffect, useMemo, useState } from "react";
import { useLogPullJobs } from "@/hooks/useLogPullJobs";
import { JobCard, type JobCardModel } from "./JobCard";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
import type { LogArchiveManifest } from "@/lib/logs/log-types";
import type { LogPullJob } from "@/lib/logs/log-job-types";

/** Default window: last 24 hours, in datetime-local (local time) format. */
function defaultWindow(): { from: string; to: string } {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return { from: fmt(past), to: fmt(now) };
}

const localToIso = (s: string) => new Date(s).toISOString();
const ACTIVE_STATUSES = ["queued", "running", "aborting", "suspending", "suspended", "interrupted"];

/** Map a LogPullJob to the generalized JobCard model (no total → no bar; show stored). */
function toLogModel(job: LogPullJob): JobCardModel {
    return {
        id: job.id,
        env: job.env,
        status: job.status,
        startedAt: job.startedAt,
        fatalError: job.fatalError,
        progress: job.progress.map((p) => ({
            label: p.source,
            fetched: p.fetched,
            expected: null,
            status: p.status,
            error: p.error,
            detail: `${p.stored.toLocaleString()} stored`,
        })),
    };
}

export function LogPullView({ environments }: { environments: { name: string; label?: string }[] }) {
    const initial = useMemo(defaultWindow, []);
    const [env, setEnv] = useState(environments[0]?.name ?? "");
    const [from, setFrom] = useState(initial.from);
    const [to, setTo] = useState(initial.to);
    const [sources, setSources] = useState<Set<string>>(new Set(DEFAULT_LOG_SOURCES));
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [manifest, setManifest] = useState<LogArchiveManifest | null>(null);

    const { jobs, start, suspend, resume, abort } = useLogPullJobs({ pollMs: 2000, includeFinished: true });

    const envJobs = useMemo(() => jobs.filter((j) => j.env === env), [jobs, env]);
    const active = useMemo(() => envJobs.find((j) => ACTIVE_STATUSES.includes(j.status)), [envJobs]);

    const terminalCount = envJobs.filter((j) => ["completed", "failed", "aborted"].includes(j.status)).length;
    useEffect(() => {
        if (!env) { setManifest(null); return; }
        let cancelled = false;
        fetch(`/api/logs/archive/manifest?env=${encodeURIComponent(env)}`)
            .then((r) => (r.ok ? r.json() : { manifest: { sources: {} } }))
            .then((d: { manifest: LogArchiveManifest }) => { if (!cancelled) setManifest(d.manifest); })
            .catch(() => { /* non-fatal */ });
        return () => { cancelled = true; };
    }, [env, terminalCount]);

    const toggleSource = (s: string) => setSources((prev) => {
        const next = new Set(prev);
        if (next.has(s)) next.delete(s); else next.add(s);
        return next;
    });

    async function onStart() {
        if (!env || sources.size === 0) return;
        setError(null);
        setStarting(true);
        try {
            const res = await start(env, [...sources], localToIso(from), localToIso(to));
            if (!res.ok) {
                setError(res.status === 409
                    ? `A pull for ${env} is already active (${res.body.jobId ?? "?"}).`
                    : res.body.error ?? `Start failed (${res.status}).`);
            }
        } catch (e) {
            setError((e as Error).message || "Failed to start pull.");
        } finally {
            setStarting(false);
        }
    }

    const inputCls = "rounded border border-slate-300 px-2 py-1.5 bg-white text-sm";

    return (
        <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Environment</span>
                        <select value={env} onChange={(e) => setEnv(e.target.value)} className={inputCls}>
                            {environments.map((e) => (
                                <option key={e.name} value={e.name}>{e.label ?? e.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">From</span>
                        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">To</span>
                        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                    </label>
                    <button
                        type="button"
                        onClick={onStart}
                        disabled={!!active || sources.size === 0 || starting}
                        title={active ? `A pull for ${env} is already active` : undefined}
                        className="ml-auto rounded bg-sky-600 px-4 py-1.5 text-white text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
                    >
                        {active ? "Pull active…" : starting ? "Starting…" : "Start pull"}
                    </button>
                </div>

                <div>
                    <div className="text-xs text-slate-500 mb-1">Sources</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                        {DEFAULT_LOG_SOURCES.map((s) => {
                            const sm = manifest?.sources?.[s];
                            return (
                                <label key={s} className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={sources.has(s)} onChange={() => toggleSource(s)} className="accent-sky-600" />
                                    <span className="font-mono text-slate-700 flex-1 truncate">{s}</span>
                                    {sm?.entryCount != null
                                        ? <span className="text-[10px] text-slate-400 tabular-nums" title={sm.lastPulledTo ? `last pulled up to ${new Date(sm.lastPulledTo).toLocaleString()}` : undefined}>{sm.entryCount.toLocaleString()}</span>
                                        : null}
                                </label>
                            );
                        })}
                    </div>
                </div>

                {error ? (
                    <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
                ) : null}
                <p className="text-xs text-slate-400">
                    Pulls run in the background and are rate-limited by AIC (~60 req/min); a busy day can take many minutes.
                    Numbers next to each source show entries already archived.
                </p>
            </div>

            <div className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-700">Active &amp; recent pulls</h2>
                {envJobs.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No pulls yet for this environment.</p>
                ) : (
                    envJobs.map((j) => (
                        <JobCard
                            key={j.id}
                            model={toLogModel(j)}
                            onSuspend={() => suspend(j.id)}
                            onResume={() => resume(j.id)}
                            onAbort={() => abort(j.id)}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
