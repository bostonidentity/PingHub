# Log Archive — Phase A2c (Pull UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Log archive" tab where a user picks an env + sources + time window, starts a pull, watches per-source progress (polled), suspends/resumes it, and sees what's already archived.

**Architecture:** Mirror the existing data-pull UI (`src/app/data/pull/PullPanel.tsx` + `useDataPullJobs` + `JobCard`): a `useLogPullJobs` polling hook over the A2b endpoints, a `LogJobCard` render component, and a `LogArchivePanel` wired as a third tab in the Report page. A shared `DEFAULT_LOG_SOURCES` constant is extracted so the route and the UI agree.

**Tech Stack:** React client components + hooks, Next.js, TypeScript. Builds on A2b API routes (`/api/logs/archive/{pull,jobs,manifest,jobs/[id]/suspend,jobs/[id]/resume}`) and A2a types (`LogPullJob`).

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md`
**Builds on:** A2b (API control plane).
**Pattern source (mirror):** `src/hooks/useDataPullJobs.ts`, `src/app/data/pull/{PullPanel,JobCard}.tsx`, `src/app/analyze/ReportTabs.tsx`, `src/app/analyze/JourneyHistoryPanel.tsx` (env/datetime controls).

---

## Testing note (read first)

This phase is React client components + a fetch/polling hook. This repo **does not unit-test `.tsx` components or fetch hooks** (Vitest coverage explicitly excludes `*.tsx`; the data-pull UI has no tests). So every task here is verified by **`npx tsc --noEmit` + `npx eslint`** and a final manual smoke test — not Vitest. The API + engine these drive are already unit-tested (A2a/A2b). Don't build a brittle DOM/timer test harness; keep components small and correct.

---

## File Structure

- `src/lib/logs/log-sources.ts` (CREATE) — shared `DEFAULT_LOG_SOURCES` constant.
- `src/app/api/logs/archive/pull/route.ts` (MODIFY) — import the shared constant instead of an inline copy.
- `src/hooks/useLogPullJobs.ts` (CREATE) — poll jobs + start/suspend/resume.
- `src/app/analyze/LogJobCard.tsx` (CREATE) — render one `LogPullJob`.
- `src/app/analyze/LogArchivePanel.tsx` (CREATE) — the tab: pull form + coverage + job list.
- `src/app/analyze/ReportTabs.tsx` (MODIFY) — add a third "Log archive" tab.
- `src/app/analyze/page.tsx` (MODIFY) — pass the new panel.

---

## Task 1: Shared `DEFAULT_LOG_SOURCES` constant

**Files:**
- Create: `src/lib/logs/log-sources.ts`
- Modify: `src/app/api/logs/archive/pull/route.ts`

- [ ] **Step 1: Create the constant** — `src/lib/logs/log-sources.ts`:

```typescript
/** Log sources the archive supports (AM + IDM). Shared by the API + the UI. */
export const DEFAULT_LOG_SOURCES = [
    "am-authentication",
    "am-access",
    "am-core",
    "idm-access",
    "idm-activity",
    "idm-authentication",
];
```

- [ ] **Step 2: Use it in the route** — in `src/app/api/logs/archive/pull/route.ts`:

Remove the inline declaration:
```typescript
/** The log sources the archive supports (AM + IDM). */
export const DEFAULT_LOG_SOURCES = [
    "am-authentication", "am-access", "am-core",
    "idm-access", "idm-activity", "idm-authentication",
];
const ALLOWED = new Set(DEFAULT_LOG_SOURCES);
```
Replace with an import (add near the other imports) and keep the `ALLOWED` set:
```typescript
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
```
and, where the removed block was, leave:
```typescript
const ALLOWED = new Set(DEFAULT_LOG_SOURCES);
```

- [ ] **Step 3: Gates**

```bash
npx tsc --noEmit
npx eslint src/lib/logs/ src/app/api/logs/archive/
```
Expected: `tsc` clean; eslint clean. (Run `npx vitest run src/lib/logs/` too — should stay green since nothing logic-level changed.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/logs/log-sources.ts src/app/api/logs/archive/pull/route.ts
git commit -m "refactor(logs): share DEFAULT_LOG_SOURCES between route and UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `useLogPullJobs` polling hook

**Files:**
- Create: `src/hooks/useLogPullJobs.ts`

- [ ] **Step 1: Create the hook** — `src/hooks/useLogPullJobs.ts`:

```typescript
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

    return { jobs, error, refresh, start, suspend, resume };
}
```

- [ ] **Step 2: Gates**

```bash
npx tsc --noEmit
npx eslint src/hooks/useLogPullJobs.ts
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useLogPullJobs.ts
git commit -m "feat(logs): useLogPullJobs polling hook (start/suspend/resume)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `LogJobCard` component

**Files:**
- Create: `src/app/analyze/LogJobCard.tsx`

- [ ] **Step 1: Create the component** — `src/app/analyze/LogJobCard.tsx`:

```tsx
"use client";

import type { LogPullJob } from "@/lib/logs/log-job-types";

const STATUS_STYLE: Record<LogPullJob["status"], string> = {
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

function timeAgo(ms: number): string {
    const delta = Math.max(0, Date.now() - ms);
    if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    return new Date(ms).toLocaleTimeString();
}

const SOURCE_DOT: Record<string, string> = {
    done: "bg-emerald-500",
    failed: "bg-rose-500",
    running: "bg-sky-500 animate-pulse",
    pending: "bg-slate-300",
};

export function LogJobCard({
    job,
    onSuspend,
    onResume,
}: {
    job: LogPullJob;
    onSuspend?: () => void;
    onResume?: () => void;
}) {
    const canSuspend = job.status === "running" || job.status === "queued";
    const canResume = job.status === "interrupted" || job.status === "suspended";
    const totalFetched = job.progress.reduce((s, p) => s + p.fetched, 0);
    const totalStored = job.progress.reduce((s, p) => s + p.stored, 0);

    return (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${STATUS_STYLE[job.status]}`}>{job.status}</span>
                <span className="text-xs font-mono text-slate-500">
                    {new Date(job.from).toLocaleString()} → {new Date(job.to).toLocaleString()}
                </span>
                <span className="ml-auto text-xs text-slate-500 tabular-nums">
                    {totalStored.toLocaleString()} stored · {totalFetched.toLocaleString()} fetched
                </span>
                {canSuspend && onSuspend ? (
                    <button type="button" onClick={onSuspend}
                        className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50">Suspend</button>
                ) : null}
                {canResume && onResume ? (
                    <button type="button" onClick={onResume}
                        className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50">Resume</button>
                ) : null}
            </div>
            <div className="text-xs text-slate-400">
                started {timeAgo(job.startedAt)}{job.fatalError ? ` · ${job.fatalError}` : ""}
            </div>
            <ul className="space-y-1">
                {job.progress.map((p) => (
                    <li key={p.source} className="flex items-center gap-2 text-xs">
                        <span className={`inline-block w-2 h-2 rounded-full ${SOURCE_DOT[p.status] ?? "bg-slate-300"}`} />
                        <span className="font-mono text-slate-600 flex-1 truncate">{p.source}</span>
                        <span className="text-slate-500 tabular-nums">{p.stored.toLocaleString()} / {p.fetched.toLocaleString()}</span>
                        {p.error
                            ? <span className="text-rose-600 truncate max-w-[40%]" title={p.error}>{p.error}</span>
                            : <span className="text-slate-400">{p.status}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
```

- [ ] **Step 2: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/analyze/LogJobCard.tsx
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/analyze/LogJobCard.tsx
git commit -m "feat(logs): LogJobCard — per-source pull progress + suspend/resume

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `LogArchivePanel` component

**Files:**
- Create: `src/app/analyze/LogArchivePanel.tsx`

- [ ] **Step 1: Create the panel** — `src/app/analyze/LogArchivePanel.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useLogPullJobs } from "@/hooks/useLogPullJobs";
import { LogJobCard } from "./LogJobCard";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
import type { LogArchiveManifest } from "@/lib/logs/log-types";

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

export function LogArchivePanel({ environments }: { environments: { name: string; label?: string }[] }) {
    const initial = useMemo(defaultWindow, []);
    const [env, setEnv] = useState(environments[0]?.name ?? "");
    const [from, setFrom] = useState(initial.from);
    const [to, setTo] = useState(initial.to);
    const [sources, setSources] = useState<Set<string>>(new Set(DEFAULT_LOG_SOURCES));
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [manifest, setManifest] = useState<LogArchiveManifest | null>(null);

    const { jobs, start, suspend, resume } = useLogPullJobs({ pollMs: 2000, includeFinished: true });

    const envJobs = useMemo(() => jobs.filter((j) => j.env === env), [jobs, env]);
    const active = useMemo(() => envJobs.find((j) => ACTIVE_STATUSES.includes(j.status)), [envJobs]);

    // Reload coverage when env changes or a job for this env reaches a terminal state.
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
                        <LogJobCard key={j.id} job={j} onSuspend={() => suspend(j.id)} onResume={() => resume(j.id)} />
                    ))
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/analyze/LogArchivePanel.tsx
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/analyze/LogArchivePanel.tsx
git commit -m "feat(logs): LogArchivePanel — pull form, coverage, job list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the third Report tab

**Files:**
- Modify: `src/app/analyze/ReportTabs.tsx`
- Modify: `src/app/analyze/page.tsx`

- [ ] **Step 1: Add the tab** — REPLACE `src/app/analyze/ReportTabs.tsx` with:

```tsx
"use client";

import { useState, type ReactNode } from "react";

type TabKey = "journeys" | "logs" | "esv";

export function ReportTabs({
    esvPanel,
    journeyPanel,
    logArchivePanel,
}: {
    esvPanel: ReactNode;
    journeyPanel: ReactNode;
    logArchivePanel: ReactNode;
}) {
    const [tab, setTab] = useState<TabKey>("journeys");
    return (
        <div className="space-y-4">
            <div className="border-b border-slate-200 flex gap-1">
                {([
                    { key: "journeys", label: "Journey execution history" },
                    { key: "logs", label: "Log archive" },
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
                {tab === "esv" ? esvPanel : tab === "logs" ? logArchivePanel : journeyPanel}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Pass the panel** — in `src/app/analyze/page.tsx`:

Add the import:
```tsx
import { LogArchivePanel } from "./LogArchivePanel";
```
And pass the new prop to `ReportTabs`:
```tsx
            <ReportTabs
                journeyPanel={<JourneyHistoryPanel environments={environments} />}
                logArchivePanel={<LogArchivePanel environments={environments} />}
                esvPanel={<AnalyzePanel environments={environments} />}
            />
```

- [ ] **Step 3: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/analyze/
npx vitest run
```
Expected: `tsc` clean; eslint clean; full Vitest suite green (unchanged — no logic touched).

- [ ] **Step 4: Commit**

```bash
git add src/app/analyze/ReportTabs.tsx src/app/analyze/page.tsx
git commit -m "feat(logs): add Log archive tab to the Report page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase A2c

- A "Log archive" tab sits between "Journey execution history" and "ESV orphans".
- It lets the user pick env + sources + window and Start a pull; the Start button is disabled while a pull is active for the env (or shows the 409 message).
- The job list polls every 2s and shows per-source status + stored/fetched counts, with Suspend (running) and Resume (suspended/interrupted) buttons.
- Each source shows its archived `entryCount` from the manifest; coverage refreshes when a pull completes.
- `tsc --noEmit` + `eslint` clean; full Vitest suite still green.

## Manual smoke test

1. Open the Report page → Log archive tab.
2. Pick `prod`, a SMALL window (e.g. 5 minutes), uncheck all sources except `am-authentication`, Start pull.
3. Watch the job card: `am-authentication` goes pending → running (stored/fetched climb) → done; job → completed. The source's archived count appears.
4. Start a longer pull and click Suspend → status → suspending → suspended; click Resume → it continues. Starting a second pull while one is active shows the 409 message.
5. Cross-check: the Journey tab with Source = Local archive over the pulled window now returns results.

## Self-review notes (author)

- **Spec coverage:** structured pull UI (env/sources/window), background pulls with poll, suspend/resume, coverage display ✓ — completes the "A" half of the original goal (offline archive usable end-to-end via UI).
- **Pattern fidelity:** mirrors `useDataPullJobs`/`PullPanel`/`JobCard`; `DEFAULT_LOG_SOURCES` shared to avoid drift; tabs extended without disturbing existing panels.
- **Placeholder scan:** none — full component code in every step.
- **Type consistency:** `LogPullJob`/`LogSourceProgress` (A2a), `LogArchiveManifest` (A1), endpoint shapes match A2b (`{jobs}`, `{manifest}`, 202/409); `useLogPullJobs.start(env, sources, from, to)` matches the panel call.
- **Testing deviation:** UI/hook verified by tsc/eslint + manual smoke (repo convention — `.tsx` excluded from Vitest). Engine/API are unit-tested in A2a/A2b.
- **Deferred:** Phase B (explore layer). A dedicated abort (hard-cancel) isn't exposed — suspend serves the stop-and-keep use case; add later if needed.
```
