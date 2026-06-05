# Journey-history report: multi-select journey filter — Design

Date: 2026-06-05
Status: Approved (pending implementation plan)
Area: `ping-aic-studio` — Journey-history report (`src/app/analyze/JourneyHistoryPanel.tsx`, `src/lib/reports/*`, `src/app/api/analyze/journey-history/*`)

## Problem

The Journey-history report currently has a single free-text **"Journey filter"** (`treeName`) — a case-insensitive substring applied at **analysis time** (after the AIC pull). Users want to:

- Pick **multiple** journeys for a report from a list.
- **See** which journeys are selected.
- **Search** the journey list (a tenant can have ~200 journeys).

A secondary goal surfaced during design: make selection **fast**, not just focused.

## Key empirical finding (probed against the `uat` tenant)

`treeName` lives only at `payload.entries[0].info.treeName` (a nested array field); it is absent at `payload.treeName`. The codebase had previously assumed AIC's CREST `_queryFilter` couldn't filter such nested fields. Testing disproved that:

- `(/payload/entries/info/treeName eq "X")` — **array-implicit path, no index** — returns **exactly** the target journey's events. Probe: 222 returned vs 222 baseline, **zero leakage**.
- `(/payload/entries/0/info/treeName eq "X")` — **indexed path** — returns **0** (this is the trap the codebase hit before).
- Multi-journey OR — `(… eq "A" or … eq "B" or … eq "C")` — returns **exactly** the sum of the individual baselines (402 = 222+162+18), per-journey counts exact, zero leakage.
- **Node events** (`AM-NODE-LOGIN-COMPLETED`) also carry `entries[0].info.treeName`, and the filter returns them — so server-side filtering is safe in **full (per-attempt)** mode too, not just summary mode.

**Conclusion:** server-side journey filtering is reliable and exact. Selecting journeys can both **scope** the report and **shrink the AIC pull** (a real, large speedup — pick 2 of 200 journeys → pull a fraction of the data), with no undercounting risk.

## Decisions

1. **Journey list source:** scan on-disk pulled config — `environments/<env>/config/<realm>/journeys/` (directory name = journey name). Reuse existing realm-path helpers (`getRealmRoots` / `resolveScopeDirs("journeys")`).
2. **No-config fallback:** if the env has no journeys config, the picker degrades to **free-text entry** — the user types a name, it becomes a selected chip. (Same `treeNames` array; just no pick-list.)
3. **Filtering is server-side and exact** for the live source; **analysis-time exact set filter** for the archive (local NDJSON) source.
4. **Param model:** replace single `treeName?: string` with `treeNames?: string[]` (exact journey names). Drops substring matching in favor of exact matching against a known list. A typo in the free-text fallback simply matches nothing.
5. **UI:** combobox + chips, theme-consistent (slate/sky Tailwind, matching the existing panel).
6. **Safety cap:** if `treeNames.length > 25`, skip the server-side OR clause (URL length + diminishing returns) and fall back to analysis-time filtering. Empty selection → no clause → all journeys (today's behavior).

## Architecture

### A. Journey-list API
`GET /api/analyze/journeys?env=<env>` (server route):
- Resolve the env's config dir; scan realm `journeys/` directories; collect directory names.
- Return `{ journeys: string[], source: "config" | "none" }` — sorted, de-duplicated. `source: "none"` when no config dir exists (drives the free-text fallback).
- Names only (no enabled/innerOnly metadata) — YAGNI for filtering.

### B. Query-filter builder (live)
A small pure helper builds the `_queryFilter`:
- Base event-name clause (`SUMMARY_FILTER` or `BROAD_FILTER`, unchanged).
- If `0 < treeNames.length <= 25`: append `and (` + `treeNames.map(n => '/payload/entries/info/treeName eq "' + esc(n) + '"').join(" or ")` + `)`.
- `esc(n)`: escape/strip embedded `"` defensively (journey names are config dir names; quotes are not expected but must not break the filter).
- Empty (or > 25): base clause only.

This clause is part of **each window's** query, so it composes automatically with windowing (`windowHours`) and parallel windows (`windowConcurrency`).

### C. Analysis-time set filter (archive + >25 fallback)
Generalize the current `applyTreeFilter` to filter by an **exact set** of journey names (match `entries[0].info.treeName` or `payload.treeName`), used:
- by the **archive** source (can't filter server-side), and
- by the live path only in the **>25 fallback**.
When server-side filtering is in effect (live, ≤25 selected), no analysis-time filter is needed — AIC already returned exactly the selected journeys.

### D. Param / type changes
- `JourneyReportParams`: `treeName?: string` → `treeNames?: string[]`.
- `jobs/route.ts` (background) and `journey-history/route.ts` (synchronous archive): parse `treeNames` from the body (array of strings, trimmed, de-duped).
- `journey-report-runner.ts`: build the query filter via the new builder; pass selected names into the report JSON for display.
- Report JSON: add `selectedJourneys?: string[]` so a saved report records its scope.

### E. UI
- `JourneyMultiSelect` component (new): combobox field + searchable checklist popover; selected journeys as removable chips with a count and "Clear all". Search filters the list client-side. When the list is empty/`source: "none"`, render the free-text add-a-name input instead.
- `JourneyHistoryPanel`: replace the `treeName` string state with `selectedJourneys: string[]`; fetch the journey list on env change; pass `treeNames` in both the live (`start`) and archive request bodies.
- Scan details: show "Journeys: A, B (2)" when `selectedJourneys` is present.

## Data flow

```
env change → GET /api/analyze/journeys?env → { journeys, source }
                                              → populate JourneyMultiSelect
user selects journeys → selectedJourneys[]
Run (live)  → POST jobs { …, treeNames }  → runner builds per-window _queryFilter
                                              (eventName) and (treeName OR …)
                                          → AIC returns only selected journeys → analyze → report
Run (archive) → POST journey-history { …, treeNames, source:"archive" }
                                          → stream local NDJSON, exact-set filter at analysis
```

## Error handling / edge cases

- **No config:** `source: "none"` → free-text fallback; report still runs (typed names go into `treeNames`).
- **Journey name with a quote:** escaped/stripped by `esc()`; if it would produce an invalid clause, that name is dropped from the server clause (and still applied client-side in the fallback path).
- **> 25 selected:** server clause skipped; analysis-time set filter applied; behavior still correct, just not faster.
- **Empty selection:** no clause — all journeys (unchanged from today).
- **Selected journey absent from the window:** simply contributes zero attempts (exact, as the probe confirmed).

## Testing

- Unit — query-filter builder: empty → base only; 1 and N names → correct OR clause; quote-escaping; > 25 → base only.
- Unit — analysis-time exact set filter: keeps only matching journeys; empty set → all.
- API route — journey listing: scans/dedupes/sorts; `source: "none"` and `[]` when no config dir.
- Runner — a `treeNames` job's window URL contains the OR clause; a > 25 job's URL does not.
- (Component tests only if the repo already has a React testing setup; otherwise cover picker logic via pure helpers.)

## Out of scope (YAGNI)

- Live AIC API call to list journeys (chose on-disk config).
- Journey metadata (enabled/innerOnly) in the picker.
- Saved/named journey-selection presets.
- Server-side filtering for the archive source.

## Notes / risks

- Server-side `treeName` filtering was validated on **uat**. Other tenants use the same CREST engine and event payload shape, so behavior should match, but the array-implicit path (`/payload/entries/info/treeName`, no index) is the load-bearing detail — keep it documented in code.
- Replacing substring with exact matching is a deliberate behavior change; the picker is the primary path, so this is acceptable and more predictable.
