# Journey-history multi-select journey filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick multiple journeys (with search + visible selection) for the Journey-history report; selection scopes the report and shrinks the AIC pull via exact server-side `treeName` filtering.

**Architecture:** A new server route lists an env's journeys by scanning pulled config. The report params change from a single substring `treeName` to an exact `treeNames: string[]`. For the live pull, selected journeys become an OR clause on the AIC `_queryFilter` (array-implicit path `/payload/entries/info/treeName eq "X"`, verified exact against uat); for the archive source and the >25-journey fallback, an exact-set filter runs at analysis time. The UI gets a searchable combobox-with-chips picker.

**Tech Stack:** Next.js (App Router) + React client components, TypeScript, Node fs, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-journey-multi-select-filter-design.md`

---

## File Structure

- Create `src/lib/reports/journey-filter.ts` — pure helpers: `buildJourneyQueryFilter`, `filterEventsByJourneys`, `MAX_SERVER_FILTER_JOURNEYS`.
- Create `src/lib/reports/journey-filter.test.ts` — unit tests for the above.
- Create `src/lib/journey-list.ts` — `scanJourneyNames(configDir)` + `listConfigJourneys(env)`.
- Create `src/lib/journey-list.test.ts` — unit tests for `scanJourneyNames`.
- Create `src/app/api/analyze/journeys/route.ts` — `GET ?env=` → `{ journeys, source }`.
- Create `src/app/analyze/journey-search.ts` — `filterJourneyOptions` (pure search helper).
- Create `src/app/analyze/journey-search.test.ts` — unit test.
- Create `src/app/analyze/JourneyMultiSelect.tsx` — the picker component.
- Modify `src/lib/reports/journey-report-types.ts` — `treeName?` → `treeNames?: string[]`.
- Modify `src/lib/reports/journey-report-runner.ts` — query building + post-filter + `selectedJourneys` in the report; remove local `applyTreeFilter`/`matchesTreeName`.
- Modify `src/lib/reports/journey-report-runner.test.ts` — assert the query filter for `treeNames` and >25 cases.
- Modify `src/app/api/analyze/journey-history/jobs/route.ts` — parse `treeNames`.
- Modify `src/app/api/analyze/journey-history/route.ts` — parse `treeNames`, build filter, post-filter.
- Modify `src/app/analyze/JourneyHistoryPanel.tsx` — selection state, fetch list, render picker, pass `treeNames`, show selection in Scan details.

Run all commands from `ping-aic-studio/`.

---

## Task 1: Journey filter helpers

**Files:**
- Create: `src/lib/reports/journey-filter.ts`
- Test: `src/lib/reports/journey-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/reports/journey-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
import type { RawAuthEvent } from "./journey-history";

const BASE = '(/payload/eventName co "AM-TREE-LOGIN-")';
const ev = (tree: string): RawAuthEvent => ({
  timestamp: "2026-06-01T00:00:00Z",
  payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: "t", entries: [{ info: { treeName: tree } }] },
});

describe("buildJourneyQueryFilter", () => {
  it("returns the base filter unchanged when no journeys are selected", () => {
    expect(buildJourneyQueryFilter(BASE, [])).toBe(BASE);
  });

  it("ANDs an OR of exact treeName matches using the array-implicit path", () => {
    expect(buildJourneyQueryFilter(BASE, ["A", "B"]))
      .toBe(`(${BASE}) and (/payload/entries/info/treeName eq "A" or /payload/entries/info/treeName eq "B")`);
  });

  it("strips embedded double-quotes from journey names", () => {
    expect(buildJourneyQueryFilter(BASE, ['a"b'])).toContain('eq "ab"');
  });

  it("falls back to the base filter above the server cap", () => {
    const many = Array.from({ length: MAX_SERVER_FILTER_JOURNEYS + 1 }, (_, i) => `J${i}`);
    expect(buildJourneyQueryFilter(BASE, many)).toBe(BASE);
  });
});

describe("filterEventsByJourneys", () => {
  it("keeps only events whose journey is in the set", () => {
    const out = filterEventsByJourneys([ev("A"), ev("B"), ev("C")], ["A", "C"]);
    expect(out).toHaveLength(2);
  });

  it("returns all events when the set is empty", () => {
    const all = [ev("A"), ev("B")];
    expect(filterEventsByJourneys(all, [])).toBe(all);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/journey-filter.test.ts`
Expected: FAIL — cannot resolve `./journey-filter`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/reports/journey-filter.ts`:

```typescript
import type { RawAuthEvent } from "./journey-history";

/**
 * Above this many selected journeys, skip the server-side OR clause (URL length
 * + diminishing returns vs. selecting nearly everything) and filter at analysis
 * time instead.
 */
export const MAX_SERVER_FILTER_JOURNEYS = 25;

/** treeName lives at entries[0].info.treeName (array element), or occasionally payload.treeName. */
function treeNameOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.treeName === "string") return p.treeName;
  const entries = p.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const info = (entries[0] as Record<string, unknown>)?.info;
    if (info && typeof info === "object") {
      const t = (info as Record<string, unknown>).treeName;
      if (typeof t === "string") return t;
    }
  }
  return undefined;
}

/** Drop embedded double-quotes so a name can't break the queryFilter expression. */
function escapeFilterValue(name: string): string {
  return name.replace(/"/g, "");
}

/**
 * Build the AIC `_queryFilter`. When 1..MAX_SERVER_FILTER_JOURNEYS journeys are
 * given, AND an OR of exact treeName matches onto the base event-name clause so
 * the tenant returns only those journeys' events. Empty (or over the cap) → base
 * clause unchanged.
 *
 * Uses the ARRAY-IMPLICIT path `/payload/entries/info/treeName` (NO numeric
 * index): AIC matches any array element this way, and the result is exact
 * (verified against the uat tenant). The indexed `/entries/0/...` path silently
 * returns nothing — do not use it.
 */
export function buildJourneyQueryFilter(baseFilter: string, treeNames: string[]): string {
  if (treeNames.length === 0 || treeNames.length > MAX_SERVER_FILTER_JOURNEYS) return baseFilter;
  const or = treeNames
    .map((n) => `/payload/entries/info/treeName eq "${escapeFilterValue(n)}"`)
    .join(" or ");
  return `(${baseFilter}) and (${or})`;
}

/**
 * Exact-set analysis-time filter: keep events whose journey is in `treeNames`.
 * Empty set → events returned unchanged (same reference). Used by the archive
 * source and the >MAX_SERVER_FILTER_JOURNEYS live fallback.
 */
export function filterEventsByJourneys(events: RawAuthEvent[], treeNames: string[]): RawAuthEvent[] {
  if (treeNames.length === 0) return events;
  const want = new Set(treeNames);
  return events.filter((e) => {
    const t = treeNameOf(e.payload);
    return t !== undefined && want.has(t);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/journey-filter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/journey-filter.ts src/lib/reports/journey-filter.test.ts
git commit -m "feat(report): journey query-filter + exact-set filter helpers"
```

---

## Task 2: Config journey-list scanner

**Files:**
- Create: `src/lib/journey-list.ts`
- Test: `src/lib/journey-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/journey-list.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { scanJourneyNames } from "./journey-list";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journeys-"));
}
function mkJourney(configDir: string, realm: string, name: string) {
  fs.mkdirSync(path.join(configDir, realm, "journeys", name), { recursive: true });
}

describe("scanJourneyNames", () => {
  it("returns sorted, de-duped journey names across realms", () => {
    const dir = tmpDir();
    mkJourney(dir, "alpha", "Login");
    mkJourney(dir, "alpha", "Agent");
    mkJourney(dir, "bravo", "Login"); // duplicate name in another realm
    const r = scanJourneyNames(dir);
    expect(r.source).toBe("config");
    expect(r.journeys).toEqual(["Agent", "Login"]);
  });

  it("returns source 'none' when the dir is null or missing", () => {
    expect(scanJourneyNames(null)).toEqual({ journeys: [], source: "none" });
    expect(scanJourneyNames(path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual({ journeys: [], source: "none" });
  });

  it("returns source 'none' when config exists but has no journeys", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });
    expect(scanJourneyNames(dir)).toEqual({ journeys: [], source: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/journey-list.test.ts`
Expected: FAIL — cannot resolve `./journey-list`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/journey-list.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./fr-config";
import { getRealmRoots } from "./realm-paths";

export interface JourneyListResult {
  journeys: string[];
  source: "config" | "none";
}

/**
 * Scan a resolved config dir for journey names:
 * `<configDir>/<realm>/journeys/<journeyName>/`. Sorted + de-duped across realms.
 * `null`/missing/empty → `{ journeys: [], source: "none" }` (drives the UI's
 * free-text fallback).
 */
export function scanJourneyNames(configDir: string | null): JourneyListResult {
  if (!configDir || !fs.existsSync(configDir)) return { journeys: [], source: "none" };
  const names = new Set<string>();
  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const e of fs.readdirSync(journeysDir, { withFileTypes: true })) {
      if (e.isDirectory()) names.add(e.name);
    }
  }
  if (names.size === 0) return { journeys: [], source: "none" };
  return { journeys: [...names].sort((a, b) => a.localeCompare(b)), source: "config" };
}

/** List journey names for an environment from its pulled config. */
export function listConfigJourneys(env: string): JourneyListResult {
  return scanJourneyNames(getConfigDir(env));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/journey-list.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/journey-list.ts src/lib/journey-list.test.ts
git commit -m "feat(report): scan pulled config for an env's journey names"
```

---

## Task 3: Journey-list API route

**Files:**
- Create: `src/app/api/analyze/journeys/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/analyze/journeys/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { listConfigJourneys } from "@/lib/journey-list";

export const dynamic = "force-dynamic";

/** GET /api/analyze/journeys?env=prod → { journeys: string[], source: "config" | "none" } */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  if (!env || !getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  return NextResponse.json(listConfigJourneys(env));
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/analyze/journeys/route.ts
git commit -m "feat(report): GET /api/analyze/journeys lists an env's journeys"
```

---

## Task 4: Param model + runner wiring

**Files:**
- Modify: `src/lib/reports/journey-report-types.ts`
- Modify: `src/lib/reports/journey-report-runner.ts`
- Test: `src/lib/reports/journey-report-runner.test.ts`

- [ ] **Step 1: Change the param type**

In `src/lib/reports/journey-report-types.ts`, replace the `treeName` field:

```typescript
  /** Optional treeName substring filter (applied at analysis time). */
  treeName?: string;
```

with:

```typescript
  /** Exact journey names to include (empty = all). Server-side filters the AIC
   * pull when small; analysis-time set filter for archive / large selections. */
  treeNames?: string[];
```

- [ ] **Step 2: Write the failing runner test**

In `src/lib/reports/journey-report-runner.test.ts`, add this test inside the `describe("runJourneyReport", ...)` block (after the existing `summaryOnly` test):

```typescript
  it("server-side filters by selected journeys, and falls back above the cap", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, treeNames: ["Login", "Signup"] });
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const decoded = decodeURIComponent(urls[0].replace(/\+/g, " "));
    expect(decoded).toContain('/payload/entries/info/treeName eq "Login" or /payload/entries/info/treeName eq "Signup"');
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.selectedJourneys).toEqual(["Login", "Signup"]);

    // Above the cap → no server clause (falls back to analysis-time filtering).
    const many = Array.from({ length: 26 }, (_, i) => `J${i}`);
    const job2 = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, treeNames: many });
    const urls2: string[] = [];
    const fetchFn2 = vi.fn(async (url: string | URL | Request) => {
      urls2.push(String(url));
      return jsonRes({ result: [], pagedResultsCookie: null });
    });
    await runJourneyReport({ ...baseOpts(root), job: job2, registry: reg, fetchFn: fetchFn2 });
    expect(decodeURIComponent(urls2[0])).not.toContain("entries/info/treeName");
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/journey-report-runner.test.ts -t "server-side filters"`
Expected: FAIL — query filter has no treeName clause / `selectedJourneys` undefined.

- [ ] **Step 4: Wire the runner**

In `src/lib/reports/journey-report-runner.ts`:

(a) Update the import of `journey-filter`. Find the existing import line:

```typescript
import { analyzeJourneyHistory, emptyRollup, mergeRollup, type RawAuthEvent } from "./journey-history";
```

and add below it:

```typescript
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
```

(b) Delete the now-unused local `matchesTreeName` and `applyTreeFilter` functions (the two functions with the comments "Match a treeName substring…" and "Keep only events whose transaction touched the filtered tree…").

(c) Replace the params/query block. Find:

```typescript
  const { from, to, treeName, maxEvents, summaryOnly, windowHours, windowConcurrency } = job.params;
  const queryFilter = summaryOnly ? SUMMARY_FILTER : BROAD_FILTER;
  const wantedEventNames = summaryOnly ? SUMMARY_EVENT_NAMES : WANTED_EVENT_NAMES;
```

with:

```typescript
  const { from, to, treeNames = [], maxEvents, summaryOnly, windowHours, windowConcurrency } = job.params;
  const baseFilter = summaryOnly ? SUMMARY_FILTER : BROAD_FILTER;
  // Live: server-side filter when the selection is small; otherwise (and for
  // every window) filter at analysis time via postFilter.
  const serverFiltered = treeNames.length > 0 && treeNames.length <= MAX_SERVER_FILTER_JOURNEYS;
  const queryFilter = buildJourneyQueryFilter(baseFilter, serverFiltered ? treeNames : []);
  const postFilter = (events: RawAuthEvent[]) =>
    treeNames.length > 0 && !serverFiltered ? filterEventsByJourneys(events, treeNames) : events;
  const wantedEventNames = summaryOnly ? SUMMARY_EVENT_NAMES : WANTED_EVENT_NAMES;
```

(d) In the single-window finalize, replace:

```typescript
        const events = readStaging(stagePath);
        const analyzed = applyTreeFilter(events, treeName);
```

with:

```typescript
        const events = readStaging(stagePath);
        const analyzed = postFilter(events);
```

(e) In the same single-window `writeReport({...})` call, add `selectedJourneys` after `topEventNames,`:

```typescript
          topEventNames,
          durationMs: Math.max(0, Date.now() - job.startedAt),
          ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
```

(f) In the chunked `foldWindow`, replace:

```typescript
      const winReport = analyzeJourneyHistory(applyTreeFilter(readStaging(winStagePath(i)), treeName));
```

with:

```typescript
      const winReport = analyzeJourneyHistory(postFilter(readStaging(winStagePath(i))));
```

(g) In the chunked final `writeReport({...})` call, add `selectedJourneys` after `durationMs: …,`:

```typescript
        durationMs: Math.max(0, Date.now() - job.startedAt),
        ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
```

- [ ] **Step 5: Run the runner tests to verify they pass**

Run: `npx vitest run src/lib/reports/journey-report-runner.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/journey-report-types.ts src/lib/reports/journey-report-runner.ts src/lib/reports/journey-report-runner.test.ts
git commit -m "feat(report): scope live report by selected journeys (server-side + fallback)"
```

---

## Task 5: Wire the two API routes to accept treeNames

**Files:**
- Modify: `src/app/api/analyze/journey-history/jobs/route.ts`
- Modify: `src/app/api/analyze/journey-history/route.ts`

- [ ] **Step 1: Background jobs route — parse treeNames**

In `src/app/api/analyze/journey-history/jobs/route.ts`, replace:

```typescript
  const treeName = typeof body.treeName === "string" && body.treeName.trim() ? body.treeName.trim() : undefined;
```

with:

```typescript
  const treeNames = Array.isArray(body.treeNames)
    ? [...new Set(
        body.treeNames
          .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t: string) => t.trim()),
      )]
    : [];
```

Then replace the `startJob` params:

```typescript
    job = registry.startJob(env, { from, to, treeName, maxEvents, summaryOnly, windowHours, windowConcurrency });
```

with:

```typescript
    job = registry.startJob(env, { from, to, treeNames, maxEvents, summaryOnly, windowHours, windowConcurrency });
```

- [ ] **Step 2: Synchronous route — parse treeNames, build filter, post-filter**

In `src/app/api/analyze/journey-history/route.ts`:

(a) Add the import near the top (next to other `@/lib` imports):

```typescript
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "@/lib/reports/journey-filter";
```

(b) Replace the destructure block:

```typescript
    const {
        env,
        from,
        to,
        treeName,
        maxEvents = DEFAULT_MAX_EVENTS,
    } = body as { env: string; from: string; to: string; treeName?: string; maxEvents?: number; source?: string };
    const source = body.source === "archive" ? "archive" : "live";
```

with:

```typescript
    const {
        env,
        from,
        to,
        maxEvents = DEFAULT_MAX_EVENTS,
    } = body as { env: string; from: string; to: string; maxEvents?: number; source?: string };
    const source = body.source === "archive" ? "archive" : "live";
    const treeNames: string[] = Array.isArray(body.treeNames)
        ? [...new Set(
            (body.treeNames as unknown[])
                .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
                .map((t) => t.trim()),
          )]
        : [];
```

(c) Replace the `broadFilter` const:

```typescript
    const broadFilter =
        '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';
```

with:

```typescript
    const baseFilter =
        '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';
    // Live + small selection → server-side filter; archive (and large selections)
    // → analysis-time set filter below.
    const serverFiltered = source === "live" && treeNames.length > 0 && treeNames.length <= MAX_SERVER_FILTER_JOURNEYS;
    const queryFilter = buildJourneyQueryFilter(baseFilter, serverFiltered ? treeNames : []);
```

(d) Delete the `treeFilterLc` const and the entire `matchesTreeName` function (the block starting `const treeFilterLc = treeName?.trim().toLowerCase();` through the closing brace of `function matchesTreeName(...) { ... }`). Keep the `eventNameCounts` line that sits between them — re-add it if removed:

```typescript
    const eventNameCounts = new Map<string, number>();
```

(e) In the live paging loop, replace `_queryFilter: broadFilter,` with `_queryFilter: queryFilter,`.

(f) Replace the analysis-time filter block (the comment "Apply treeName filter at the transactionId level…" through the closing `}` of the `if (treeFilterLc) { ... }`):

```typescript
                // Apply treeName filter at the transactionId level so the analyzer
                // still sees companion events for any txn that touches the tree.
                let analyzed = allEvents;
                if (treeFilterLc) {
                    const keepTxns = new Set<string>();
                    for (const e of allEvents) {
                        if (!matchesTreeName(e.payload)) continue;
                        if (typeof e.payload === "object" && e.payload !== null) {
                            const t = (e.payload as Record<string, unknown>).transactionId;
                            if (typeof t === "string") keepTxns.add(t);
                        }
                    }
                    analyzed = allEvents.filter((e) => {
                        if (typeof e.payload !== "object" || e.payload === null) return false;
                        const t = (e.payload as Record<string, unknown>).transactionId;
                        return typeof t === "string" && keepTxns.has(t);
                    });
                }
```

with:

```typescript
                // Archive (and >cap live selections) couldn't be filtered server-side
                // → apply the exact-set journey filter at analysis time.
                const analyzed = treeNames.length > 0 && !serverFiltered
                    ? filterEventsByJourneys(allEvents, treeNames)
                    : allEvents;
```

- [ ] **Step 3: Type-check + run existing journey-history route tests**

Run: `npx tsc --noEmit`
Expected: no output (clean).

Run: `npx vitest run src/app/api/analyze/journey-history/route.test.ts`
Expected: PASS (existing tests still green).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/analyze/journey-history/jobs/route.ts src/app/api/analyze/journey-history/route.ts
git commit -m "feat(report): accept treeNames[] in the journey-history routes"
```

---

## Task 6: Picker search helper + component

**Files:**
- Create: `src/app/analyze/journey-search.ts`
- Test: `src/app/analyze/journey-search.test.ts`
- Create: `src/app/analyze/JourneyMultiSelect.tsx`

- [ ] **Step 1: Write the failing search-helper test**

Create `src/app/analyze/journey-search.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { filterJourneyOptions } from "./journey-search";

describe("filterJourneyOptions", () => {
  const all = ["Login", "kyid_2B1_MasterLogin", "Agent"];

  it("returns all options for an empty query", () => {
    expect(filterJourneyOptions(all, "  ")).toBe(all);
  });

  it("matches case-insensitive substrings", () => {
    expect(filterJourneyOptions(all, "login")).toEqual(["Login", "kyid_2B1_MasterLogin"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterJourneyOptions(all, "zzz")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/analyze/journey-search.test.ts`
Expected: FAIL — cannot resolve `./journey-search`.

- [ ] **Step 3: Write the search helper**

Create `src/app/analyze/journey-search.ts`:

```typescript
/** Case-insensitive substring filter over journey names. Empty query → same array reference. */
export function filterJourneyOptions(all: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((n) => n.toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/analyze/journey-search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the picker component**

Create `src/app/analyze/JourneyMultiSelect.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { filterJourneyOptions } from "./journey-search";

interface Props {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** No config list for this env → allow typing arbitrary journey names. */
  freeText: boolean;
  disabled?: boolean;
}

/** Searchable multi-select for journeys: a combobox popover of checkboxes plus
 * removable chips for the current selection. Degrades to free-text entry when
 * the env has no pulled config. */
export function JourneyMultiSelect({ available, selected, onChange, freeText, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  const remove = (name: string) => onChange(selected.filter((n) => n !== name));
  const addFreeText = () => {
    const n = query.trim();
    if (n && !selected.includes(n)) onChange([...selected, n]);
    setQuery("");
  };

  const options = filterJourneyOptions(available, query);

  return (
    <div className="text-sm" ref={boxRef}>
      <span className="block text-slate-600 mb-1">Journeys (optional)</span>
      <div className="relative">
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && freeText) { e.preventDefault(); addFreeText(); } }}
          placeholder={freeText ? "type a journey name, Enter to add" : "search journeys…"}
          className="w-64 rounded border border-slate-300 px-2 py-1.5 bg-white disabled:opacity-50"
        />
        {open && !freeText && options.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-60 w-64 overflow-auto rounded border border-slate-300 bg-white shadow">
            {options.map((n) => (
              <label key={n} className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 cursor-pointer">
                <input type="checkbox" checked={selected.includes(n)} onChange={() => toggle(n)} />
                <span className="font-mono text-xs">{n}</span>
              </label>
            ))}
          </div>
        )}
        {open && !freeText && options.length === 0 && (
          <div className="absolute z-10 mt-1 w-64 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-500 shadow">
            No journeys match.
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {selected.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800">
              <span className="font-mono">{n}</span>
              <button type="button" onClick={() => remove(n)} className="text-sky-600 hover:text-sky-900">×</button>
            </span>
          ))}
          <span className="text-xs text-slate-500">({selected.length})</span>
          <button type="button" onClick={() => onChange([])} className="text-xs text-slate-500 underline hover:text-slate-700">
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add src/app/analyze/journey-search.ts src/app/analyze/journey-search.test.ts src/app/analyze/JourneyMultiSelect.tsx
git commit -m "feat(report): searchable multi-select journey picker component"
```

---

## Task 7: Wire the picker into the panel

**Files:**
- Modify: `src/app/analyze/JourneyHistoryPanel.tsx`

- [ ] **Step 1: Import the picker**

Near the other imports at the top of `src/app/analyze/JourneyHistoryPanel.tsx`, add:

```typescript
import { JourneyMultiSelect } from "./JourneyMultiSelect";
```

- [ ] **Step 2: Replace the treeName state with selection + list state**

Find:

```typescript
    const [treeName, setTreeName] = useState("");
```

Replace with:

```typescript
    const [selectedJourneys, setSelectedJourneys] = useState<string[]>([]);
    const [journeyOptions, setJourneyOptions] = useState<string[]>([]);
    const [journeySource, setJourneySource] = useState<"config" | "none">("none");
```

- [ ] **Step 3: Fetch the journey list when the env changes**

Add this effect immediately after the `const job = useMemo(...)` / hook setup near the top of the component body (anywhere inside the component, after the state declarations):

```typescript
    // Load the env's journeys for the picker; reset selection on env change.
    useEffect(() => {
        if (!env) { setJourneyOptions([]); setJourneySource("none"); return; }
        let cancelled = false;
        setSelectedJourneys([]);
        fetch(`/api/analyze/journeys?env=${encodeURIComponent(env)}`)
            .then((r) => (r.ok ? r.json() : { journeys: [], source: "none" }))
            .then((d: { journeys: string[]; source: "config" | "none" }) => {
                if (cancelled) return;
                setJourneyOptions(d.journeys);
                setJourneySource(d.source);
            })
            .catch(() => { if (!cancelled) { setJourneyOptions([]); setJourneySource("none"); } });
        return () => { cancelled = true; };
    }, [env]);
```

- [ ] **Step 4: Pass treeNames in both request bodies**

In the live `start(env, { ... })` call, replace:

```typescript
            treeName: treeName.trim() || undefined,
```

with:

```typescript
            treeNames: selectedJourneys,
```

In the archive fetch body (the `runArchive` function), replace:

```typescript
                    treeName: treeName.trim() || undefined,
```

with:

```typescript
                    treeNames: selectedJourneys,
```

- [ ] **Step 5: Replace the free-text filter input with the picker**

Find the journey-filter label block:

```tsx
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Journey filter (optional)</span>
                        <input type="text" value={treeName} onChange={(e) => setTreeName(e.target.value)}
                            placeholder="exact treeName"
                            className="w-full rounded border border-slate-300 px-2 py-1.5 bg-white" />
                    </label>
```

Replace with:

```tsx
                    <JourneyMultiSelect
                        available={journeyOptions}
                        selected={selectedJourneys}
                        onChange={setSelectedJourneys}
                        freeText={journeySource === "none"}
                    />
```

- [ ] **Step 6: Show the selected journeys in the report's Scan details**

In the `ScanReport` type definition, add a field after `windowHours?: number;`:

```typescript
    /** Journeys the report was scoped to (empty/absent = all). */
    selectedJourneys?: string[];
```

In the `ScanDetails` component's `items` array, add a row after the `Window` row entry (the `...(report.window ? [...] : [])` entry):

```typescript
        ...(report.selectedJourneys && report.selectedJourneys.length
            ? [{ label: "Journeys", value: `${report.selectedJourneys.join(", ")} (${report.selectedJourneys.length})` }]
            : []),
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 8: Commit**

```bash
git add src/app/analyze/JourneyHistoryPanel.tsx
git commit -m "feat(report): journey multi-select in the Journey-history panel"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 2: Lint the changed files**

Run:

```bash
npx eslint \
  src/lib/reports/journey-filter.ts \
  src/lib/journey-list.ts \
  src/app/api/analyze/journeys/route.ts \
  src/app/api/analyze/journey-history/jobs/route.ts \
  src/app/api/analyze/journey-history/route.ts \
  src/app/analyze/journey-search.ts \
  src/app/analyze/JourneyMultiSelect.tsx \
  src/app/analyze/JourneyHistoryPanel.tsx \
  src/lib/reports/journey-report-runner.ts \
  src/lib/reports/journey-report-types.ts
```

Expected: no output (clean).

- [ ] **Step 3: Run the full report + journey test suites**

Run: `npx vitest run src/lib/reports/ src/lib/journey-list.test.ts src/app/analyze/journey-search.test.ts src/app/api/analyze/journey-history/route.test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(report): verify journey multi-select feature"
```

(Skip if nothing changed.)

---

## Self-Review notes (for the implementer)

- **Behavior change:** the old substring `treeName` filter is replaced by exact `treeNames`. A typo in the free-text fallback matches nothing — that's intended (the pick-list is the primary path).
- **Composes with windowing/parallelism:** the query filter is built once and used by every window's request, so it works with `windowHours` + `windowConcurrency` unchanged.
- **Server-side path is exact** (verified against uat): `/payload/entries/info/treeName eq "X"` — array-implicit, NO index. Keep that detail in `journey-filter.ts`'s doc comment.
- **Archive source** always filters at analysis time (no server query to constrain).
