// src/app/data/pull/PullPanel.tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";
import { useDataEnv, timeAgoShort } from "@/hooks/useDataEnv";
import { JobCard, type JobCardModel } from "./JobCard";
import { getFocus, subscribeFocus, clearFocus, type PullFocus } from "./job-focus";
import {
  startProbe, abortProbe, getProbeState, subscribeProbe,
  loadProbes, probeKey, PROBE_MAX_AGE_MS, type ProbedEntry,
} from "./probe-store";
import type { Environment } from "@/lib/fr-config";
import type { SnapshotType, DataPullJob } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/** Denominator for a type: server total, else a probed count, else unknown. */
function expectedFor(pTotal: number | null, probed: number | null | undefined): number | null {
  if (typeof pTotal === "number" && pTotal >= 0) return pTotal;
  if (typeof probed === "number" && probed >= 0) return probed;
  return null;
}

/** Map a managed DataPullJob (+ probed counts) to the generalized JobCard model. */
function toManagedModel(job: DataPullJob, probed: Record<string, number | null>): JobCardModel {
  return {
    id: job.id,
    env: job.env,
    status: job.status,
    startedAt: job.startedAt,
    fatalError: job.fatalError,
    kind: "managed",
    progress: job.progress.map((p) => {
      const expected = expectedFor(p.total, probed[p.type]);
      const expectedFromProbe = (p.total === null || p.total === undefined) && expected !== null;
      return { label: p.type, fetched: p.fetched, expected, expectedFromProbe, status: p.status, error: p.error };
    }),
  };
}


export function PullPanel({
  environments,
  typesByEnv,
}: {
  environments: Environment[];
  typesByEnv: Record<string, string[]>;
}) {
  const { env, setEnv } = useDataEnv(environments);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [envLastPulledAt, setEnvLastPulledAt] = useState<number | null>(null);
  // Live probe state (env, progress, errors) from the module store — survives
  // tab/route changes, so navigating away and back keeps showing a probe.
  const [probe, setProbe] = useState(getProbeState);
  useEffect(() => subscribeProbe(() => setProbe(getProbeState())), []);

  // Counts are sparse: undefined = never probed, null = probed but tenant
  // declined to count, number = real count. Keyed by type within the current env.
  // The store persists results to localStorage; re-read them whenever it signals
  // a new result (and once on mount), so denominators stay live.
  const [allProbes, setAllProbes] = useState<Record<string, ProbedEntry>>({});
  useEffect(() => { setAllProbes(loadProbes()); }, [probe.resultsVersion]);

  // Derive per-env views from the store for the current env.
  const counts = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const [key, entry] of Object.entries(allProbes)) {
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      if (key.slice(0, sep) === env) m[key.slice(sep + 2)] = entry.count;
    }
    return m;
  }, [allProbes, env]);
  const countReasons = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [key, entry] of Object.entries(allProbes)) {
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      if (key.slice(0, sep) === env && entry.reason) m[key.slice(sep + 2)] = entry.reason;
    }
    return m;
  }, [allProbes, env]);

  // Scope the store's probe view to the env on screen.
  const probingThisEnv = probe.probing && probe.env === env;
  const currentlyProbing = probe.env === env ? probe.currentlyProbing : null;
  const probeProgress = probe.env === env ? probe.progress : {};
  const probeError = probe.env === env ? probe.error : null;
  const [prePullChecking, setPrePullChecking] = useState(false);

  const { jobs, start, abort, resume, suspend } = useDataPullJobs({ pollMs: 2000, includeFinished: true });
  const types = useMemo(() => typesByEnv[env] ?? [], [typesByEnv, env]);

  // Client-side pagination for the activity list. Jobs come from the API in
  // newest-first order; we keep that ordering and slice 10 at a time so long
  // histories don't dominate the panel. Reset to page 1 when the env changes
  // or when the underlying job count shrinks below the current page.
  const JOBS_PAGE_SIZE = 10;
  const [jobsPage, setJobsPage] = useState(1);
  useEffect(() => { setJobsPage(1); }, [env]);
  const jobsTotalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
  useEffect(() => {
    if (jobsPage > jobsTotalPages) setJobsPage(jobsTotalPages);
  }, [jobsPage, jobsTotalPages]);
  const pagedJobs = useMemo(
    () => jobs.slice((jobsPage - 1) * JOBS_PAGE_SIZE, jobsPage * JOBS_PAGE_SIZE),
    [jobs, jobsPage],
  );

  // "Go to this job" from the unfinished-jobs panel. Active jobs are newest, so
  // they live on page 1; jump there and briefly highlight the target card.
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  useEffect(() => {
    const act = (f: PullFocus) => { if (f.mode !== "managed") return; setJobsPage(1); setFocusedJobId(f.jobId); };
    const pending = getFocus();
    if (pending) { act(pending); clearFocus(); }
    return subscribeFocus(act);
  }, []);
  useEffect(() => {
    if (!focusedJobId) return;
    const el = document.getElementById(`job-${focusedJobId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setFocusedJobId(null), 2500);
    return () => clearTimeout(t);
  }, [focusedJobId, pagedJobs]);
  const visibleTypes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? types.filter((t) => t.toLowerCase().includes(q)) : types;
  }, [types, filter]);
  const active = useMemo(
    () => jobs.find((j) => j.env === env && (
      j.status === "running"
      || j.status === "queued"
      || j.status === "aborting"
      || j.status === "suspending"
      || j.status === "suspended"
      || j.status === "interrupted"
    )),
    [jobs, env],
  );

  // Fetch the env's most-recent pull time. Re-fetches on env change and whenever
  // a job transitions to a terminal state, so the label stays fresh after a pull.
  const terminalCount = jobs.filter((j) =>
    j.env === env && (j.status === "completed" || j.status === "failed" || j.status === "aborted"),
  ).length;
  useEffect(() => {
    if (!env) { setEnvLastPulledAt(null); return; }
    let cancelled = false;
    fetch(`/api/data/snapshots/${env}`)
      .then((r) => r.ok ? r.json() : { types: [] })
      .then((d: { types: SnapshotType[] }) => {
        if (cancelled) return;
        const max = d.types.reduce((mx, t) => Math.max(mx, t.pulledAt), 0);
        setEnvLastPulledAt(max || null);
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [env, terminalCount]);

  const toggle = (t: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });
  // Select/Deselect "all" operates on the currently-visible (filtered) types,
  // so narrowing the filter first lets the user act on a subset.
  const selectAll = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const t of visibleTypes) next.add(t);
    return next;
  });
  const deselectAll = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const t of visibleTypes) next.delete(t);
    return next;
  });

  const probeCounts = async () => {
    if (!env || selected.size === 0 || probingThisEnv) return;
    await startProbe(env, [...selected]);
  };

  const canStart = !active && selected.size > 0 && !prePullChecking;

  const onStart = async () => {
    setError(null);
    setPrePullChecking(true);
    try {
      // Determine which selected types have stale or missing probe counts.
      const staleTypes = [...selected].filter((t) => {
        const entry = allProbes[probeKey(env, t)];
        return !entry || entry.probedAt == null || Date.now() - entry.probedAt > PROBE_MAX_AGE_MS;
      });

      // Re-probe stale types before starting the pull.
      if (staleTypes.length > 0) {
        await startProbe(env, staleTypes);
      }

      const res = await start(env, [...selected]);
      if (!res.ok) {
        setError(res.status === 409
          ? `A pull for ${env} is already running (${res.body.jobId}).`
          : res.body.error ?? `Start failed (${res.status}).`);
      }
    } catch (e) {
      setError((e as Error).message || "Failed to start pull.");
    } finally {
      setPrePullChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">
              Environment
              {envLastPulledAt && (
                <span className="ml-2 text-slate-400 font-normal" title={new Date(envLastPulledAt).toLocaleString()}>
                  · last pulled {timeAgoShort(envLastPulledAt)}
                </span>
              )}
            </label>
            <select
              value={env}
              onChange={(e) => {
                setEnv(e.target.value);
                setSelected(new Set());
                setFilter("");
                // Probe state is env-scoped in the store, so it self-hides for
                // the new env; an in-flight probe for the old env keeps running.
              }}
              className="px-3 py-1.5 text-sm border border-slate-300 rounded bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-400"
            >
              {environments.map((e) => (
                <option key={e.name} value={e.name}>{e.label ?? e.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={selectAll}
              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
            >Select all</button>
            <button
              type="button"
              onClick={deselectAll}
              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
            >Deselect all</button>
            <button
              type="button"
              onClick={probeCounts}
              disabled={probingThisEnv || prePullChecking || selected.size === 0}
              title={
                selected.size === 0
                  ? "Check one or more types above to probe"
                  : `Query the ${selected.size} selected type${selected.size === 1 ? "" : "s"}' record counts without starting a pull`
              }
              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {probingThisEnv ? "Probing…" : `Probe counts${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
            {probingThisEnv && (
              <button
                type="button"
                onClick={abortProbe}
                title="Cancel the running probe"
                className="px-2 py-1 text-xs border border-rose-300 rounded bg-white text-rose-700 hover:bg-rose-50"
              >Cancel</button>
            )}
          </div>
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            title={active ? `Job ${active.id} already running` : undefined}
            className="ml-auto px-4 py-1.5 text-sm bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {prePullChecking ? "Checking counts…" : active ? "Pull in progress…" : "Start pull"}
          </button>
        </div>

        {types.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter types by name…"
                className="w-full pl-7 pr-6 py-1 text-xs rounded border border-slate-300 text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter("")}
                  title="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[10px]"
                >✕</button>
              )}
            </div>
            <span className="text-[11px] text-slate-400 tabular-nums">
              {visibleTypes.length} / {types.length}
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
          {types.length === 0 && (
            <p className="text-xs text-slate-400 italic">No managed object schema found for this env.</p>
          )}
          {types.length > 0 && visibleTypes.length === 0 && (
            <p className="text-xs text-slate-400 italic">No types match the filter.</p>
          )}
          {visibleTypes.map((t) => {
            const has = Object.prototype.hasOwnProperty.call(counts, t);
            const c = counts[t];
            const isProbing = currentlyProbing === t;
            const prog = probeProgress[t];
            return (
              <label
                key={t}
                className={cn(
                  "flex items-center gap-2 text-sm rounded px-1 transition-colors",
                  isProbing && "bg-sky-50 ring-1 ring-inset ring-sky-200",
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(t)}
                  onChange={() => toggle(t)}
                  className="accent-sky-600"
                />
                <span className="font-mono text-slate-700 flex-1 truncate">{t}</span>
                {isProbing ? (
                  <span className="text-[10px] text-sky-700 font-mono tabular-nums">
                    {prog
                      ? <>probing… {prog.fetched.toLocaleString()}<span className="text-sky-400">/p{prog.pages}</span></>
                      : "probing…"}
                  </span>
                ) : has ? (
                  (() => {
                    const reason = countReasons[t];
                    const isSnapshotSourced = c !== null && !!reason;
                    const className = c === null
                      ? "text-[10px] text-slate-400 italic cursor-help"
                      : isSnapshotSourced
                        ? "text-[10px] text-slate-500 italic font-mono tabular-nums cursor-help"
                        : "text-[10px] text-slate-500 font-mono tabular-nums";
                    const title = c === null
                      ? (reason ?? "Tenant declined to report a count")
                      : isSnapshotSourced
                        ? `${c.toLocaleString()} records — ${reason}`
                        : `${c.toLocaleString()} records`;
                    return (
                      <span className={className} title={title}>
                        {c === null ? "unknown" : isSnapshotSourced ? `${c.toLocaleString()}*` : c.toLocaleString()}
                      </span>
                    );
                  })()
                ) : null}
              </label>
            );
          })}
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
            {error}
          </div>
        )}
        {probeError && (
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded">
            Probe error: {probeError}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Active & recent jobs</h2>
          {jobs.length > JOBS_PAGE_SIZE && (
            <span className="text-xs text-slate-500">
              {(jobsPage - 1) * JOBS_PAGE_SIZE + 1}–{Math.min(jobs.length, jobsPage * JOBS_PAGE_SIZE)} of {jobs.length}
            </span>
          )}
        </div>
        {jobs.length === 0 && (
          <p className="text-xs text-slate-400 italic">No jobs yet.</p>
        )}
        {pagedJobs.map((j) => {
          // Per-job probed-count map: counts for j.env/type, in case the server
          // preflight returned null (tenant doesn't honor _countPolicy).
          const probedForJob: Record<string, number | null> = {};
          for (const [key, entry] of Object.entries(allProbes)) {
            const sep = key.indexOf("::");
            if (sep < 0) continue;
            if (key.slice(0, sep) === j.env) probedForJob[key.slice(sep + 2)] = entry.count;
          }
          return (
            <div
              key={j.id}
              id={`job-${j.id}`}
              className={cn(
                "rounded-xl transition-shadow",
                focusedJobId === j.id && "ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-50",
              )}
            >
              <JobCard
                model={toManagedModel(j, probedForJob)}
                onAbort={() => abort(j.id)}
                onResume={() => resume(j.id)}
                onSuspend={() => suspend(j.id)}
              />
            </div>
          );
        })}
        {jobs.length > JOBS_PAGE_SIZE && (
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => setJobsPage((p) => Math.max(1, p - 1))}
              disabled={jobsPage <= 1}
              className="text-xs px-2 py-1 border border-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              ← Newer
            </button>
            <span className="text-xs text-slate-500">Page {jobsPage} of {jobsTotalPages}</span>
            <button
              type="button"
              onClick={() => setJobsPage((p) => Math.min(jobsTotalPages, p + 1))}
              disabled={jobsPage >= jobsTotalPages}
              className="text-xs px-2 py-1 border border-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              Older →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
