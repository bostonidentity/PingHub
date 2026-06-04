# Log Archive — Phase D (Logs Local/Remote Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Remote (live AIC) | Local (archive) toggle to the Logs **Search** mode, so search can run against the local archive; then remove the now-redundant Log Explorer tab from Report.

**Architecture:** A `dataSource` field on `TabConfig` + a toggle shown only in Search mode. When `local`, `runSearch` bypasses the Web Worker and queries `POST /api/logs/archive/query` directly (paged, capped), maps `ArchiveQueryRow.payloadJson` → the existing `LogEntry` shape, and sets the same display state the worker path sets. Tail and Transaction modes are unchanged (always remote). Source aliases (`am-everything`/`idm-everything`) expand to the archive's real sources.

**Tech Stack:** React client component (`LogsExplorer.tsx`), Next.js, TypeScript. UI verified by `tsc` + `eslint` + `next build` + manual smoke (repo `.tsx` convention). The `/query` API is unit-tested (B1).

**Reference:** integration map in `LogsExplorer.tsx` (LogEntry ~line 70; TabConfig ~228; runSearch ~3169–3243; worker handler ~3006; search controls ~3862; makeDefaultConfig ~4993). Builds on B1 (`/api/logs/archive/query`).

---

## Task 1: Local search in the Logs explorer

**Files:**
- Modify: `src/app/logs/LogsExplorer.tsx`

This is one cohesive change. Read the file to place each edit at the locations described (line numbers are approximate guides).

- [ ] **Step 1: Add the `dataSource` field to `TabConfig`** (interface ~line 228). Add:
```typescript
    /** Search-mode data source: live AIC ("remote") or the local archive ("local"). */
    dataSource?: "remote" | "local";
```

- [ ] **Step 2: Default it in `makeDefaultConfig`** (~line 4993). Add to the returned object:
```typescript
    dataSource: "remote",
```
(`sanitizeConfigForPersist` spreads `...cfg`, so `dataSource` already persists — no change needed there. If you find it explicitly lists fields instead of spreading, add `dataSource: cfg.dataSource ?? "remote"`.)

- [ ] **Step 3: Add module-level helpers** near the other top-level helpers in the file (e.g. just after the `LogEntry` interface or near `getComponent`). Import `DEFAULT_LOG_SOURCES` at the top of the file (`import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";`).

```typescript
/** Expand the Logs source picker's aliases to the archive's real sources. */
function toArchiveSources(selected: string[]): string[] {
    const out = new Set<string>();
    for (const s of selected) {
        if (s === "am-everything") DEFAULT_LOG_SOURCES.filter((x) => x.startsWith("am-")).forEach((x) => out.add(x));
        else if (s === "idm-everything") DEFAULT_LOG_SOURCES.filter((x) => x.startsWith("idm-")).forEach((x) => out.add(x));
        else if (DEFAULT_LOG_SOURCES.includes(s)) out.add(s);
    }
    return [...out];
}

/** Map an archive query row (payloadJson = full entry JSON) to a displayed LogEntry. */
function mapArchiveRowToEntry(row: { payloadJson: string; timestamp: string; source: string }): LogEntry & { source: string } {
    try {
        const e = JSON.parse(row.payloadJson) as { timestamp?: string; type?: string; source?: string; payload?: unknown };
        return {
            timestamp: e.timestamp ?? row.timestamp,
            type: e.type ?? "",
            source: e.source ?? row.source,
            payload: (e.payload ?? {}) as Record<string, unknown> | string,
        };
    } catch {
        return { timestamp: row.timestamp, type: "", source: row.source, payload: { __raw: row.payloadJson } };
    }
}

/** Page the archive query (capped) and return mapped entries + total. */
async function fetchLocalSearchEntries(params: {
    env: string; sources: string[]; from: string; to: string; text?: string; level?: string;
}): Promise<{ entries: (LogEntry & { source: string })[]; total: number; capped: boolean }> {
    const LIMIT = 1000;
    const MAX = 5000;
    const entries: (LogEntry & { source: string })[] = [];
    let total = 0;
    let offset = 0;
    for (;;) {
        const res = await fetch("/api/logs/archive/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...params, offset, limit: LIMIT }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        total = typeof data.total === "number" ? data.total : 0;
        const rows: { payloadJson: string; timestamp: string; source: string }[] = Array.isArray(data.rows) ? data.rows : [];
        for (const r of rows) entries.push(mapArchiveRowToEntry(r));
        offset += rows.length;
        if (rows.length < LIMIT || entries.length >= MAX || offset >= total) break;
    }
    return { entries, total, capped: entries.length < total };
}
```

- [ ] **Step 4: Branch `runSearch` for local** (~line 3169–3243). After the state-reset block (`setError(""); setEntries([]); setFetched(false); ... setFetchProgress(null); ... onConfigChange({ searching: true });`) and BEFORE the existing `workerRef.current?.postMessage({ type: "fetch", ... })`, insert:

```typescript
        if (config.dataSource === "local") {
            const text = searchKeywordsRawRef.current.trim() || undefined;
            const lv = resolveLevels(levelFilter);
            const level = lv.length === 1 ? lv[0] : undefined;
            const archiveSources = toArchiveSources(selectedSources);
            void fetchLocalSearchEntries({ env, sources: archiveSources, from: beginTime, to: endTime, text, level })
                .then(({ entries, total, capped }) => {
                    setEntries(entries);
                    setFetched(true);
                    setLastUpdated(new Date());
                    setFetchProgress({
                        loaded: entries.length,
                        page: 1,
                        done: true,
                        paused: false,
                        source: "local archive",
                        window: capped ? `first ${entries.length.toLocaleString()} of ${total.toLocaleString()} — refine to see more` : undefined,
                    });
                    onConfigChange({ searching: false });
                })
                .catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                    onConfigChange({ searching: false });
                });
            return; // skip the worker (remote) path
        }
```

Notes for placement: `beginTime`/`endTime` are the resolved ISO strings computed just above in `runSearch`; `selectedSources`, `levelFilter`, `env`, `resolveLevels`, `searchKeywordsRawRef`, `setEntries`, `setFetched`, `setLastUpdated`, `setFetchProgress`, `setError`, `onConfigChange`, and `config` are all in scope there (the worker `postMessage` below uses the same names). If `setLastUpdated` isn't in scope in `runSearch`, drop that line (it's cosmetic).

- [ ] **Step 5: Add the Remote | Local toggle** in the Search-mode controls (~line 3862, inside the `{mode === "search" && (() => { ... })()}` block — put it near the time-range selector / Search button row). Insert this control (uses `cn`, already imported):

```tsx
                  <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                    {(["remote", "local"] as const).map((ds) => (
                      <button
                        key={ds}
                        type="button"
                        onClick={() => onConfigChange({ dataSource: ds })}
                        disabled={loading || searching}
                        title={ds === "local"
                          ? "Search the local archive (offline; text matches indexed fields only — pull data first via Data → Pull → Logs)"
                          : "Search live AIC"}
                        className={cn(
                          "px-2 py-0.5 text-[11px] font-medium transition-colors",
                          (config.dataSource ?? "remote") === ds
                            ? "bg-slate-900 text-white"
                            : "bg-white text-slate-500 hover:bg-slate-50",
                        )}
                      >
                        {ds === "remote" ? "Remote" : "Local"}
                      </button>
                    ))}
                  </div>
```

(If `loading`/`searching` aren't in scope in that render block, use just `disabled={searching}` or drop `disabled`. Match the existing mode-button pattern nearby.)

- [ ] **Step 6: Gates**
```bash
npx tsc --noEmit
npx eslint src/app/logs/LogsExplorer.tsx
```
Expected: `tsc` clean; eslint clean (if a pre-existing `react-hooks/purity` or similar warning exists on lines you didn't touch, leave it; there must be no NEW issues on your added lines).

- [ ] **Step 7: Commit**
```bash
git add src/app/logs/LogsExplorer.tsx
git commit -m "feat(logs): Local | Remote search toggle (query the archive offline)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove the Log Explorer tab from Report

**Files:**
- Modify: `src/app/analyze/ReportTabs.tsx`
- Modify: `src/app/analyze/page.tsx`
- Delete: `src/app/analyze/LogExplorePanel.tsx`

- [ ] **Step 1: Replace `src/app/analyze/ReportTabs.tsx`** with (Journey · ESV only):

```tsx
"use client";

import { useState, type ReactNode } from "react";

type TabKey = "journeys" | "esv";

export function ReportTabs({
    esvPanel,
    journeyPanel,
}: {
    esvPanel: ReactNode;
    journeyPanel: ReactNode;
}) {
    const [tab, setTab] = useState<TabKey>("journeys");
    return (
        <div className="space-y-4">
            <div className="border-b border-slate-200 flex gap-1">
                {([
                    { key: "journeys", label: "Journey execution history" },
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
            <div>{tab === "esv" ? esvPanel : journeyPanel}</div>
        </div>
    );
}
```

- [ ] **Step 2: Replace `src/app/analyze/page.tsx`** with (drop the LogExplorePanel import + prop):

```tsx
import { getEnvironments } from "@/lib/fr-config";
import { AnalyzePanel } from "./AnalyzePanel";
import { JourneyHistoryPanel } from "./JourneyHistoryPanel";
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
        esvPanel={<AnalyzePanel environments={environments} />}
      />
    </div>
  );
}
```

- [ ] **Step 3: Delete the panel**
```bash
git rm src/app/analyze/LogExplorePanel.tsx
```

- [ ] **Step 4: Full verification**
```bash
npx tsc --noEmit
npx eslint src/app/analyze/ src/app/logs/LogsExplorer.tsx
grep -rn "LogExplorePanel" src   # must be empty
npx vitest run                   # full suite green
npx next build                   # must succeed
```
Expected: `tsc` clean; eslint clean (pre-existing AnalyzePanel.tsx warnings excepted); grep empty; suite green; build succeeds.

- [ ] **Step 5: Commit**
```bash
git add src/app/analyze/ReportTabs.tsx src/app/analyze/page.tsx
git commit -m "feat(report): remove Log explorer tab (superseded by Logs local search)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- Logs → Search mode shows a **Remote | Local** toggle (only in Search mode); Local runs the search against the archive (`/query`), renders results in the same views, shows a "first N of M — refine" note when capped, and never calls the worker. Tail/Transaction unchanged.
- Source aliases expand correctly; text/level/sources/time honored (text = indexed-field substring).
- Report tab shows Journey · ESV only; `LogExplorePanel` deleted, no dangling refs.
- `tsc` + `eslint` clean; full Vitest suite green; `next build` succeeds.

## Manual smoke test
1. Data → Pull → Logs: pull a small `prod` `am-authentication` window.
2. Logs → Search, set the same window + sources, toggle **Local**, Search → results from the archive (no live call); try a keyword + a single level.
3. Toggle **Remote**, Search → live results (worker path) still works.
4. Report tab no longer shows Log explorer.

## Self-review notes
- Local path is additive: it branches before the worker `postMessage` and returns, so the remote/worker/tail/transaction paths are untouched.
- Reuses the transaction-mode direct-fetch + setEntries pattern; maps via `payloadJson` (the archive stores the full entry).
- Cap at 5,000 entries with a "refine" note (mirrors the explorer's capped UX); exact-match event/user filters from the old explorer are not carried over (free-text + level + sources + time cover the common cases; can add later).
- Removing Log explorer is safe — local search + the existing entry inspector supersede it.
