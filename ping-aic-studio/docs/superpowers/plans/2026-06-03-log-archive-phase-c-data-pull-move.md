# Log Archive — Phase C (Move Pull into Data/Pull) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move the Log Archive pull UI into the Data → Pull sub-tab behind a "Managed objects | Logs" segmented control, reusing a generalized `JobCard`; add an Abort action for log jobs; remove the "Log archive" tab from Report.

**Architecture:** `/data/pull` renders a client `PullSwitcher` (segmented control) → `PullPanel` (managed) or `LogPullView` (logs, moved from `analyze/LogArchivePanel`). `JobCard` is generalized to a presentation-only component over a normalized `JobCardModel`; both callers map their job type to it. A `DELETE /api/logs/archive/jobs/[id]` abort endpoint mirrors managed pull. Report keeps Journey · Log explorer · ESV.

**Tech Stack:** React client components, Next.js, TypeScript. UI verified by `tsc` + `eslint` + `next build` (repo `.tsx` convention); the abort route mirrors the tested suspend/resume pattern.

**Out of scope (separate follow-up):** Logs local/remote search toggle; removing the Log explorer tab.

---

## Task 1: Generalize `JobCard` + update managed `PullPanel`

**Files:**
- Modify (full replace): `src/app/data/pull/JobCard.tsx`
- Modify: `src/app/data/pull/PullPanel.tsx`

- [ ] **Step 1: Replace `src/app/data/pull/JobCard.tsx` with:**

```tsx
// src/app/data/pull/JobCard.tsx
"use client";

import type { DataPullJob } from "@/lib/data/types";
import { cn } from "@/lib/utils";

export type JobCardStatus = DataPullJob["status"];

export interface JobCardRow {
  /** Type (managed) or source (logs). */
  label: string;
  fetched: number;
  /** Known denominator → progress bar + ETA. null → no bar (e.g. logs have no total). */
  expected: number | null;
  /** Marks the expected value as probe-sourced (managed only) → renders a `*`. */
  expectedFromProbe?: boolean;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  /** Extra inline note shown when there's no bar (e.g. "8,001 stored" for logs). */
  detail?: string;
}

export interface JobCardModel {
  id: string;
  env: string;
  status: JobCardStatus;
  startedAt: number;
  fatalError?: string;
  progress: JobCardRow[];
}

const STATUS_STYLE: Record<JobCardStatus, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  aborting: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  aborted: "bg-slate-100 text-slate-500",
  interrupted: "bg-amber-100 text-amber-800",
  suspending: "bg-indigo-100 text-indigo-700",
  suspended: "bg-indigo-100 text-indigo-800",
};

const MIN_ELAPSED_FOR_ETA_MS = 10_000;

function timeAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ms).toLocaleTimeString();
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

/** Presentation-only job card over a normalized model (managed + log pulls). */
export function JobCard({
  model,
  onAbort,
  onResume,
  onSuspend,
}: {
  model: JobCardModel;
  onAbort: () => void;
  onResume?: () => void;
  onSuspend?: () => void;
}) {
  const canAbort = model.status === "running" || model.status === "queued" || model.status === "interrupted" || model.status === "suspended";
  const canSuspend = model.status === "running" || model.status === "queued";
  const canResume = model.status === "interrupted" || model.status === "suspended";
  const isRunning = model.status === "running" || model.status === "queued" || model.status === "aborting" || model.status === "suspending";
  const elapsedMs = Date.now() - model.startedAt;

  // Header ETA only when every row's expected is known (else a partial total misleads).
  let totalFetched = 0;
  let totalExpected = 0;
  let anyUnknown = false;
  for (const p of model.progress) {
    totalFetched += p.fetched;
    if (p.expected === null) anyUnknown = true;
    else totalExpected += p.expected;
  }
  const etaMs = (
    isRunning
    && !anyUnknown
    && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS
    && totalFetched > 0
    && totalExpected > totalFetched
  )
    ? Math.round((totalExpected - totalFetched) * (elapsedMs / totalFetched))
    : null;
  const ratePerSec = isRunning && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS && totalFetched > 0
    ? totalFetched / (elapsedMs / 1000)
    : null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-xs text-slate-500">{model.env}</span>
        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold rounded", STATUS_STYLE[model.status])}>
          {model.status}
        </span>
        <span className="text-xs text-slate-500">started {timeAgo(model.startedAt)}</span>
        {etaMs !== null && (
          <span
            className="text-xs text-sky-700"
            title={ratePerSec ? `${Math.round(ratePerSec).toLocaleString()} records/sec` : undefined}
          >
            · ~{formatDuration(etaMs)} remaining
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canSuspend && onSuspend && (
            <button
              type="button"
              onClick={onSuspend}
              title="Pause this pull. You can resume it later (even after a server restart) and it will continue from where it left off."
              className="px-2 py-0.5 text-xs border border-indigo-400 rounded bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
            >Suspend</button>
          )}
          {canResume && onResume && (
            <button
              type="button"
              onClick={onResume}
              className="px-2 py-0.5 text-xs border border-amber-400 rounded bg-amber-50 text-amber-800 hover:bg-amber-100"
            >Resume</button>
          )}
          {canAbort && (
            <button
              type="button"
              onClick={onAbort}
              title={canResume ? "Discard this paused pull and free the env so a fresh pull can start." : undefined}
              className="px-2 py-0.5 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
            >Abort</button>
          )}
        </div>
      </div>
      {model.fatalError && (
        <div className={cn(
          "px-2 py-1.5 border text-xs rounded font-mono break-all",
          model.status === "suspended" || model.status === "suspending"
            ? "bg-indigo-50 border-indigo-200 text-indigo-800"
            : "bg-rose-50 border-rose-200 text-rose-700",
        )}>
          {model.fatalError}
        </div>
      )}
      <div className="space-y-1">
        {model.progress.map((p) => {
          const pct = p.expected !== null && p.expected > 0
            ? Math.min(100, Math.round((p.fetched / p.expected) * 100))
            : null;
          return (
            <div key={p.label} className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-slate-700 w-40 truncate" title={p.label}>{p.label}</span>
                {p.expected !== null ? (
                  <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
                    {pct !== null && (
                      <div
                        className={cn("h-full", p.status === "failed" ? "bg-rose-400" : "bg-sky-500")}
                        style={{ width: `${pct}%` }}
                      />
                    )}
                  </div>
                ) : (
                  <span className="flex-1 text-[10px] text-slate-400 truncate">{p.detail ?? ""}</span>
                )}
                <span
                  className="text-slate-500 tabular-nums w-28 text-right"
                  title={p.expectedFromProbe ? "Denominator from the Probe counts value" : undefined}
                >
                  {p.fetched.toLocaleString()}
                  {p.expected !== null ? ` / ${p.expected.toLocaleString()}${p.expectedFromProbe ? "*" : ""}` : ""}
                </span>
                <span className={cn("text-[10px] w-16", p.status === "failed" ? "text-rose-600 font-semibold" : "text-slate-400")}>
                  {p.status}
                </span>
              </div>
              {p.status === "failed" && p.error && (
                <div className="ml-40 pl-2 text-[11px] text-rose-700 bg-rose-50 border-l-2 border-rose-300 px-2 py-1 rounded-r font-mono break-all">
                  {p.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `src/app/data/pull/PullPanel.tsx` to build a `JobCardModel`.**

(a) Change the JobCard import line `import { JobCard } from "./JobCard";` to:
```typescript
import { JobCard, type JobCardModel } from "./JobCard";
```
(b) Ensure `DataPullJob` is imported. The file imports `import type { SnapshotType } from "@/lib/data/types";` — change it to:
```typescript
import type { SnapshotType, DataPullJob } from "@/lib/data/types";
```
(c) Add these two module-level helpers (place them right after the imports, before the `PullPanel` component):
```typescript
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
    progress: job.progress.map((p) => {
      const expected = expectedFor(p.total, probed[p.type]);
      const expectedFromProbe = (p.total === null || p.total === undefined) && expected !== null;
      return { label: p.type, fetched: p.fetched, expected, expectedFromProbe, status: p.status, error: p.error };
    }),
  };
}
```
(d) Replace the `<JobCard ... />` usage. The current call is:
```tsx
            <JobCard
              key={j.id}
              job={j}
              probedCounts={probedForJob}
              onAbort={() => abort(j.id)}
              onResume={() => resume(j.id)}
              onSuspend={() => suspend(j.id)}
            />
```
with:
```tsx
            <JobCard
              key={j.id}
              model={toManagedModel(j, probedForJob)}
              onAbort={() => abort(j.id)}
              onResume={() => resume(j.id)}
              onSuspend={() => suspend(j.id)}
            />
```

- [ ] **Step 3: Gates** — `npx tsc --noEmit` (clean), `npx eslint src/app/data/pull/` (clean).

- [ ] **Step 4: Commit** (ONLY these two files):
```bash
git add src/app/data/pull/JobCard.tsx src/app/data/pull/PullPanel.tsx
git commit -m "refactor(pull): generalize JobCard to a normalized model (managed pull unchanged)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Abort endpoint for log jobs + hook action

**Files:**
- Create: `src/app/api/logs/archive/jobs/[id]/route.ts`
- Modify: `src/hooks/useLogPullJobs.ts`

- [ ] **Step 1: Create `src/app/api/logs/archive/jobs/[id]/route.ts`:**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogRegistry } from "@/lib/logs/log-job-registry";
import { getController } from "../../route-controllers";

export const dynamic = "force-dynamic";

/**
 * Abort (discard) a log pull. Mirrors the managed-pull DELETE: a running job is
 * aborted via its controller (the runner finalizes to "aborted"); a paused
 * (interrupted/suspended) job — which has no live runner — is set to "aborted"
 * directly so the env's active-job slot is freed for a fresh start.
 */
export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const registry = getLogRegistry();
    const job = registry.getJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (job.status === "completed" || job.status === "failed" || job.status === "aborted") {
        return new NextResponse(null, { status: 204 });
    }
    if (job.status === "interrupted" || job.status === "suspended") {
        registry.setJobStatus(id, "aborted");
        return new NextResponse(null, { status: 204 });
    }
    registry.setJobStatus(id, "aborting");
    getController(id)?.abort();
    return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 2: Add `abort` to `src/hooks/useLogPullJobs.ts`.**

After the `resume` useCallback (before the `return` statement), add:
```typescript
    const abort = useCallback(async (id: string): Promise<ActionResult> => {
        const res = await fetch(`/api/logs/archive/jobs/${id}`, { method: "DELETE" });
        const body = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, status: res.status, body };
    }, [refresh]);
```
And change the return to include it:
```typescript
    return { jobs, error, refresh, start, suspend, resume, abort };
```

- [ ] **Step 3: Gates** — `npx tsc --noEmit` (clean); `npx eslint src/app/api/logs/archive/ src/hooks/useLogPullJobs.ts` (clean).

- [ ] **Step 4: Commit** (ONLY these two files):
```bash
git add "src/app/api/logs/archive/jobs/[id]/route.ts" src/hooks/useLogPullJobs.ts
git commit -m "feat(logs): abort (discard) endpoint for log pull jobs + hook action

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `LogPullView` + `PullSwitcher` + wire the Pull page

**Files:**
- Create: `src/app/data/pull/LogPullView.tsx`
- Create: `src/app/data/pull/PullSwitcher.tsx`
- Modify: `src/app/data/pull/page.tsx`

- [ ] **Step 1: Create `src/app/data/pull/LogPullView.tsx`** (moved from `analyze/LogArchivePanel.tsx`, using the generalized `JobCard` + abort):

```tsx
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
```

- [ ] **Step 2: Create `src/app/data/pull/PullSwitcher.tsx`:**

```tsx
"use client";

import { useState } from "react";
import { PullPanel } from "./PullPanel";
import { LogPullView } from "./LogPullView";
import type { Environment } from "@/lib/fr-config";

export function PullSwitcher({
    environments,
    typesByEnv,
}: {
    environments: Environment[];
    typesByEnv: Record<string, string[]>;
}) {
    const [mode, setMode] = useState<"managed" | "logs">("managed");
    return (
        <div className="space-y-4">
            <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
                {(["managed", "logs"] as const).map((m) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`px-3 py-1.5 ${mode === m ? "bg-sky-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
                    >
                        {m === "managed" ? "Managed objects" : "Logs"}
                    </button>
                ))}
            </div>
            {mode === "managed"
                ? <PullPanel environments={environments} typesByEnv={typesByEnv} />
                : <LogPullView environments={environments} />}
        </div>
    );
}
```

- [ ] **Step 3: Update `src/app/data/pull/page.tsx`** — change the import + render from `PullPanel` to `PullSwitcher`:

Replace `import { PullPanel } from "./PullPanel";` with:
```typescript
import { PullSwitcher } from "./PullSwitcher";
```
Replace the return `return <PullPanel environments={environments} typesByEnv={typesByEnv} />;` with:
```tsx
  return <PullSwitcher environments={environments} typesByEnv={typesByEnv} />;
```

- [ ] **Step 4: Gates** — `npx tsc --noEmit` (clean); `npx eslint src/app/data/pull/` (clean).

- [ ] **Step 5: Commit** (ONLY these three files):
```bash
git add src/app/data/pull/LogPullView.tsx src/app/data/pull/PullSwitcher.tsx src/app/data/pull/page.tsx
git commit -m "feat(logs): log pull under Data/Pull via Managed objects | Logs switcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Remove Log archive from Report + delete moved files

**Files:**
- Modify: `src/app/analyze/ReportTabs.tsx`
- Modify: `src/app/analyze/page.tsx`
- Delete: `src/app/analyze/LogArchivePanel.tsx`
- Delete: `src/app/analyze/LogJobCard.tsx`

- [ ] **Step 1: Update `src/app/analyze/ReportTabs.tsx`** — remove the "Log archive" tab + its prop. Replace the file with:

```tsx
"use client";

import { useState, type ReactNode } from "react";

type TabKey = "journeys" | "explore" | "esv";

export function ReportTabs({
    esvPanel,
    journeyPanel,
    logExplorePanel,
}: {
    esvPanel: ReactNode;
    journeyPanel: ReactNode;
    logExplorePanel: ReactNode;
}) {
    const [tab, setTab] = useState<TabKey>("journeys");
    return (
        <div className="space-y-4">
            <div className="border-b border-slate-200 flex gap-1">
                {([
                    { key: "journeys", label: "Journey execution history" },
                    { key: "explore", label: "Log explorer" },
                    { key: "esv", label: "ESV orphans" },
                ] as { key: TabKey; label: string }[]).map((t) => (
                    <button
                        key={t.key}
                        type="button"
                        onClick={() => setTab(t.key)}
                        className={
                            `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key
                                ? "border-sky-600 text-sky-700"
                                : "border-transparent text-slate-600 hover:text-slate-800"
                            }`
                        }
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            <div>
                {tab === "esv" ? esvPanel
                    : tab === "explore" ? logExplorePanel
                        : journeyPanel}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Update `src/app/analyze/page.tsx`** — drop the `LogArchivePanel` import and the `logArchivePanel` prop. Replace the file with:

```tsx
import { getEnvironments } from "@/lib/fr-config";
import { AnalyzePanel } from "./AnalyzePanel";
import { JourneyHistoryPanel } from "./JourneyHistoryPanel";
import { LogExplorePanel } from "./LogExplorePanel";
import { ReportTabs } from "./ReportTabs";

export default function AnalyzePage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Report</h1>
        <p className="text-slate-500 mt-1">
          Journey execution history and ESV orphan reference reports.
        </p>
      </div>
      <ReportTabs
        journeyPanel={<JourneyHistoryPanel environments={environments} />}
        logExplorePanel={<LogExplorePanel environments={environments} />}
        esvPanel={<AnalyzePanel environments={environments} />}
      />
    </div>
  );
}
```

- [ ] **Step 3: Delete the moved/retired files:**
```bash
git rm src/app/analyze/LogArchivePanel.tsx src/app/analyze/LogJobCard.tsx
```

- [ ] **Step 4: Full verification:**
```bash
npx tsc --noEmit
npx eslint src/app/analyze/ src/app/data/pull/
npx vitest run
npx next build
```
Expected: `tsc` clean; eslint clean (pre-existing AnalyzePanel.tsx warnings excepted); full Vitest suite green; `next build` succeeds. Confirm there are no remaining imports of `LogArchivePanel` or `LogJobCard` (`grep -rn "LogArchivePanel\|LogJobCard" src` → only this plan, none in src).

- [ ] **Step 5: Commit:**
```bash
git add src/app/analyze/ReportTabs.tsx src/app/analyze/page.tsx
git commit -m "feat(report): remove Log archive tab (moved to Data/Pull); retire LogJobCard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `/data/pull` shows a "Managed objects | Logs" switcher; Logs renders the pull form + jobs list using the generalized `JobCard`, with Suspend/Resume/**Abort**.
- Managed pull renders identically to before (generalized card, same bars/ETA/probe `*`).
- `DELETE /api/logs/archive/jobs/[id]` aborts/discards a log job.
- Report tab shows Journey · Log explorer · ESV (no Log archive); `LogArchivePanel`/`LogJobCard` deleted with no dangling imports.
- `tsc` + `eslint` clean; full Vitest suite green; `next build` succeeds.

## Self-review notes
- Generalized `JobCard` preserves managed output (bar/ETA/probe `*`) via `toManagedModel`; logs use `expected:null` + `detail` ("N stored"). `JobCardStatus = DataPullJob["status"]` accepts `LogJobStatus` (identical literal unions).
- Abort mirrors the managed DELETE exactly (running → controller abort → runner finalizes "aborted"; paused → set "aborted").
- No Vitest for `.tsx`/hooks (repo convention); covered by tsc/eslint/build + a managed-pull + log-pull manual smoke.
- Scope: Log explorer stays in Report (removed in the deferred Logs-search follow-up).
