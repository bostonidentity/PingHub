// src/app/data/pull/PullPanel.tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import { useDataPullJobs } from "@/hooks/useDataPullJobs";
import { JobCard } from "./JobCard";
import type { Environment } from "@/lib/fr-config";
import { cn } from "@/lib/utils";

// Probe results persist across reloads, keyed by "<env>::<type>".
const PROBE_STORE_KEY = "data-probe-counts-v1";
type ProbedEntry = { count: number | null; reason?: string };
function loadProbes(): Record<string, ProbedEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PROBE_STORE_KEY);
    return raw ? JSON.parse(raw) as Record<string, ProbedEntry> : {};
  } catch { return {}; }
}
function saveProbes(store: Record<string, ProbedEntry>): void {
  try { localStorage.setItem(PROBE_STORE_KEY, JSON.stringify(store)); } catch { /* quota */ }
}
const probeKey = (env: string, type: string) => `${env}::${type}`;

export function PullPanel({
  environments,
  typesByEnv,
}: {
  environments: Environment[];
  typesByEnv: Record<string, string[]>;
}) {
  const [env, setEnv] = useState(environments[0]?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Counts are sparse: undefined = never probed, null = probed but tenant
  // declined to count, number = real count. Keyed by type within the current env.
  // All probed counts across envs, mirrored to localStorage so they survive reloads.
  const [allProbes, setAllProbes] = useState<Record<string, ProbedEntry>>({});
  // Rehydrate after mount (avoid SSR/CSR mismatch).
  useEffect(() => { setAllProbes(loadProbes()); }, []);

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

  function recordProbe(t: string, count: number | null, reason?: string): void {
    setAllProbes((prev) => {
      const next = { ...prev, [probeKey(env, t)]: reason ? { count, reason } : { count } };
      saveProbes(next);
      return next;
    });
  }

  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [currentlyProbing, setCurrentlyProbing] = useState<string | null>(null);
  // Live pagination progress per type (ephemeral, only populated during active probe).
  const [probeProgress, setProbeProgress] = useState<Record<string, { fetched: number; pages: number }>>({});

  const { jobs, start, abort } = useDataPullJobs({ pollMs: 2000, includeFinished: true });
  const types = useMemo(() => typesByEnv[env] ?? [], [typesByEnv, env]);
  const visibleTypes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? types.filter((t) => t.toLowerCase().includes(q)) : types;
  }, [types, filter]);
  const active = useMemo(
    () => jobs.find((j) => j.env === env && (j.status === "running" || j.status === "queued" || j.status === "aborting")),
    [jobs, env],
  );

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

  type ProbeEvent =
    | { event: "start"; type: string }
    | { event: "progress"; type: string; fetched: number; pages: number }
    | { event: "done"; type: string; count: number | null; reason?: string }
    | { event: "fatal"; error: string }
    | { event: "end" };

  const probeCounts = async () => {
    if (!env || selected.size === 0 || probing) return;
    const typesToProbe = [...selected];
    setProbing(true);
    setProbeError(null);
    // Drop stale progress for the types we're about to re-probe.
    setProbeProgress((prev) => {
      const next = { ...prev };
      for (const t of typesToProbe) delete next[t];
      return next;
    });

    try {
      const res = await fetch(`/api/data/count/${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ types: typesToProbe }),
      });
      if (!res.ok || !res.body) {
        setProbeError(`Probe failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as ProbeEvent;
            if (ev.event === "start") {
              setCurrentlyProbing(ev.type);
            } else if (ev.event === "progress") {
              setProbeProgress((prev) => ({ ...prev, [ev.type]: { fetched: ev.fetched, pages: ev.pages } }));
            } else if (ev.event === "done") {
              recordProbe(ev.type, ev.count, ev.reason);
            } else if (ev.event === "fatal") {
              setProbeError(ev.error);
            }
          } catch { /* ignore malformed line */ }
        }
      }
    } catch (e) {
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
      setCurrentlyProbing(null);
    }
  };

  const canStart = !active && selected.size > 0;

  const onStart = async () => {
    setError(null);
    const res = await start(env, [...selected]);
    if (!res.ok) {
      setError(res.status === 409
        ? `A pull for ${env} is already running (${res.body.jobId}).`
        : res.body.error ?? `Start failed (${res.status}).`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">Environment</label>
            <select
              value={env}
              onChange={(e) => {
                setEnv(e.target.value);
                setSelected(new Set());
                setFilter("");
                setProbeProgress({});
                setProbeError(null);
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
              disabled={probing || selected.size === 0}
              title={
                selected.size === 0
                  ? "Check one or more types above to probe"
                  : `Query the ${selected.size} selected type${selected.size === 1 ? "" : "s"}' record counts without starting a pull`
              }
              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {probing ? "Probing…" : `Probe counts${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
          </div>
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            title={active ? `Job ${active.id} already running` : undefined}
            className="ml-auto px-4 py-1.5 text-sm bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {active ? "Pull in progress…" : "Start pull"}
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
                  <span
                    className={c === null ? "text-[10px] text-slate-400 italic cursor-help" : "text-[10px] text-slate-500 font-mono tabular-nums"}
                    title={c === null ? (countReasons[t] ?? "Tenant declined to report a count") : `${c} records`}
                  >
                    {c === null ? "unknown" : c.toLocaleString()}
                  </span>
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
        <h2 className="text-sm font-semibold text-slate-700">Active & recent jobs</h2>
        {jobs.length === 0 && (
          <p className="text-xs text-slate-400 italic">No jobs yet.</p>
        )}
        {jobs.map((j) => <JobCard key={j.id} job={j} onAbort={() => abort(j.id)} />)}
      </div>
    </div>
  );
}
