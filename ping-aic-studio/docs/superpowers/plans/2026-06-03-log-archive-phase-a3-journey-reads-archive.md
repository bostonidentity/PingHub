# Log Archive — Phase A3 (Journey Report Reads the Archive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Journey execution-history report read `am-authentication` events from the local log archive instead of live AIC — an offline, instant, never-truncated source — via a Live | Archive toggle.

**Architecture:** The journey route gains a `source` body param. `"live"` keeps the existing AIC paging. `"archive"` reads the window from the local archive (`readRange`), runs the **same** `analyzeJourneyHistory` + treeName filter + event-name diagnostics, and reports manifest **coverage** of the requested window so the user knows whether to pull first. The panel adds the toggle and a coverage banner. We also fold in the env-allowlist hardening the security review flagged for this route (it constructs file paths from `env`).

**Tech Stack:** Next.js route handler (NDJSON streaming), React (client panel), TypeScript, Vitest. Builds on A1 (`readRange`, `readManifest`, `logDataDir`) and the journey analyzer.

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md`
**Builds on:** A1/A2a/A2b (the archive can now be populated) + the journey-history report (now committed: streaming + pagination fix + no-INITIATED analyzer).

---

## File Structure

- `src/lib/logs/manifest.ts` (MODIFY) — add pure `rangeCoverage(ranges, from, to)` → `"full" | "partial" | "none"`.
- `src/app/api/analyze/journey-history/route.ts` (MODIFY) — `source` branch (archive read) + env allowlist + `source`/`coverage` in the `done` message.
- `src/app/api/analyze/journey-history/route.test.ts` (MODIFY) — mock the archive read; add an archive-source test; keep the live tests green.
- `src/app/analyze/JourneyHistoryPanel.tsx` (MODIFY) — Live | Archive toggle + coverage banner.

---

## Task 1: `rangeCoverage` helper

**Files:**
- Modify: `src/lib/logs/manifest.ts`
- Test: `src/lib/logs/manifest.test.ts`

- [ ] **Step 1: Write the failing tests** — add this describe block to `src/lib/logs/manifest.test.ts`:

```typescript
import { rangeCoverage } from "./manifest"; // merge into the existing import from "./manifest"

describe("rangeCoverage", () => {
    const ranges = [
        { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        { from: "2026-06-04T00:00:00Z", to: "2026-06-05T00:00:00Z" },
    ];
    it("returns 'none' when the window is outside every covered range", () => {
        expect(rangeCoverage(ranges, "2026-06-03T00:00:00Z", "2026-06-03T12:00:00Z")).toBe("none");
        expect(rangeCoverage([], "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBe("none");
    });
    it("returns 'full' when a single covered range contains the window", () => {
        expect(rangeCoverage(ranges, "2026-06-01T06:00:00Z", "2026-06-01T18:00:00Z")).toBe("full");
        expect(rangeCoverage(ranges, "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBe("full");
    });
    it("returns 'partial' when the window only overlaps part of the coverage", () => {
        expect(rangeCoverage(ranges, "2026-06-01T12:00:00Z", "2026-06-03T00:00:00Z")).toBe("partial");
        // spans the gap between the two ranges
        expect(rangeCoverage(ranges, "2026-06-01T12:00:00Z", "2026-06-04T12:00:00Z")).toBe("partial");
    });
});
```

(Merge `rangeCoverage` into the existing `import { ... } from "./manifest";` line — do not add a duplicate import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/logs/manifest.test.ts`
Expected: FAIL — `rangeCoverage` is not exported.

- [ ] **Step 3: Implement** — add to `src/lib/logs/manifest.ts` (and export it):

```typescript
/**
 * How well a set of (merged, disjoint) covered ranges covers the window
 * [from, to]: "full" if one range contains it, "none" if no range overlaps it,
 * else "partial".
 */
export function rangeCoverage(ranges: TimeRange[], from: string, to: string): "full" | "partial" | "none" {
    const overlapping = ranges.filter((r) => r.from <= to && r.to >= from);
    if (overlapping.length === 0) return "none";
    if (overlapping.some((r) => r.from <= from && r.to >= to)) return "full";
    return "partial";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/logs/manifest.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: "no logs type errors"; eslint clean.

- [ ] **Step 6: Commit** (stage ONLY these two files)

```bash
git add src/lib/logs/manifest.ts src/lib/logs/manifest.test.ts
git commit -m "feat(logs): rangeCoverage helper for window-vs-coverage classification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Journey route — archive source branch

**Files:**
- Modify: `src/app/api/analyze/journey-history/route.ts` (full replacement below)
- Modify: `src/app/api/analyze/journey-history/route.test.ts`

- [ ] **Step 1: Add the failing archive test** — in `src/app/api/analyze/journey-history/route.test.ts`:

(a) Extend the existing `vi.mock("@/lib/fr-config", ...)` to also export `getEnvironments` (the route now allowlists env for ALL sources, so every test needs `prod` to be a known env). The mock becomes:

```typescript
vi.mock("@/lib/fr-config", () => ({
    getLogApiCredentials: () => ({ apiKey: "k", apiSecret: "s" }),
    getEnvFileContent: () => "TENANT_BASE_URL=https://tenant.example.com",
    getEnvironments: () => [{ name: "prod" }],
}));
```

(b) Add a mock for the archive store near the other `vi.mock` calls at the top of the file:

```typescript
vi.mock("@/lib/logs/log-archive-store", () => ({
    readRange: () => [
        { timestamp: "2026-06-02T10:00:00Z", source: "am-authentication", payload: { eventName: "AM-TREE-LOGIN-INITIATED", transactionId: "t1", entries: [{ info: { treeName: "Login" } }] } },
        { timestamp: "2026-06-02T10:00:01Z", source: "am-authentication", payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: "t1", entries: [{ info: { displayName: "User/Pass", nodeOutcome: "success" } }] } },
        { timestamp: "2026-06-02T10:00:02Z", source: "am-authentication", payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: "t1", result: "SUCCESSFUL", entries: [{ info: { treeName: "Login" } }] } },
    ],
}));
```

(c) Add this test (inside the existing top-level `describe(...)` block):

```typescript
    it("source=archive reads journey events from the local archive (no AIC paging)", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const res = await POST(req({
            env: "prod", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", source: "archive",
        }));
        const messages = await readNdjson(res);

        expect(fetchMock).not.toHaveBeenCalled(); // archive never hits AIC
        const done = messages.find((m) => m.type === "done");
        expect(done).toBeDefined();
        expect(done).toMatchObject({
            source: "archive",
            summary: expect.objectContaining({ attempts: 1, success: 1 }),
        });
        // No manifest on disk for this test env → coverage is "none".
        expect(done!.coverage).toBe("none");
    });
```

(If `readNdjson` / `req` helpers are not already in this file, they are — they were added when the route was first tested. Reuse them.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/analyze/journey-history/route.test.ts`
Expected: FAIL — the response has no `source`/`coverage` and the archive branch doesn't exist yet (currently it would try the live path).

- [ ] **Step 3: Implement** — REPLACE the entire contents of `src/app/api/analyze/journey-history/route.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent, getEnvironments } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { analyzeJourneyHistory, type RawAuthEvent } from "@/lib/reports/journey-history";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { readRange } from "@/lib/logs/log-archive-store";
import { readManifest, rangeCoverage } from "@/lib/logs/manifest";

/**
 * Produce a journey-history report for the requested window. Two sources:
 *   - "live" (default): page `am-authentication` from AIC's /monitoring/logs.
 *   - "archive": read `am-authentication` from the local log archive — offline,
 *     instant, never truncated. Requires a prior pull (Phase A2).
 *
 * Body: { env, from, to, treeName?, maxEvents?, source? }
 * Streams NDJSON: progress* then a final `done` (or `error`).
 */

const DEFAULT_MAX_EVENTS = 20000;
const HARD_MAX_EVENTS = 100000;
const JOURNEY_SOURCE = "am-authentication";

export async function POST(req: NextRequest) {
    const body = await req.json();
    const {
        env,
        from,
        to,
        treeName,
        maxEvents = DEFAULT_MAX_EVENTS,
    } = body as { env: string; from: string; to: string; treeName?: string; maxEvents?: number; source?: string };
    const source = body.source === "archive" ? "archive" : "live";

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
    }
    // Allowlist env against real environments before any file-path construction.
    if (!getEnvironments().some((e) => e.name === env)) {
        return NextResponse.json({ error: "unknown environment" }, { status: 400 });
    }
    const cap = Math.min(Math.max(1, Math.floor(maxEvents)), HARD_MAX_EVENTS);

    // Live mode needs Log-API credentials + tenant URL; archive mode reads disk.
    let tenantBaseUrl = "";
    let authHeaders: Record<string, string> = {};
    if (source === "live") {
        const creds = getLogApiCredentials(env);
        if (!creds) return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
        const vars = parseEnvFile(getEnvFileContent(env));
        tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "") ?? "";
        if (!tenantBaseUrl) return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
        authHeaders = { "x-api-key": creds.apiKey, "x-api-secret": creds.apiSecret };
    }

    // AIC's /monitoring/logs queryFilter support is finicky — `eq` on
    // /payload/eventName and nested-array paths return empty silently in
    // practice. We narrow with `co` (contains) and re-filter client-side.
    const broadFilter =
        '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';

    const allEvents: RawAuthEvent[] = [];
    let cookie: string | undefined;
    let truncated = false;
    let pages = 0;
    let rawFetched = 0;
    let coverage: "full" | "partial" | "none" | undefined;
    const MAX_PAGES = 200; // safety net against pathological loops

    const wantedEventNames = new Set([
        "AM-TREE-LOGIN-INITIATED",
        "AM-TREE-LOGIN-COMPLETED",
        "AM-NODE-LOGIN-COMPLETED",
    ]);
    const treeFilterLc = treeName?.trim().toLowerCase();
    const eventNameCounts = new Map<string, number>();

    // Substring match across both treeName fields the analyzer pulls from.
    function matchesTreeName(payload: unknown): boolean {
        if (!treeFilterLc) return true;
        if (typeof payload !== "object" || payload === null) return false;
        const p = payload as Record<string, unknown>;
        const direct = typeof p.treeName === "string" ? p.treeName.toLowerCase() : "";
        if (direct.includes(treeFilterLc)) return true;
        const entries = p.entries;
        if (Array.isArray(entries) && entries.length > 0) {
            const info = (entries[0] as Record<string, unknown>)?.info;
            const t = info && typeof info === "object" && typeof (info as Record<string, unknown>).treeName === "string"
                ? ((info as Record<string, unknown>).treeName as string).toLowerCase() : "";
            if (t.includes(treeFilterLc)) return true;
        }
        return false;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (msg: unknown) => controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
            try {
                if (source === "archive") {
                    // Read the window straight from local NDJSON. No paging, no cap
                    // on bytes over the wire; we still honor `cap` defensively.
                    const archiveRoot = logDataDir(env);
                    const manifest = readManifest(archiveRoot);
                    coverage = rangeCoverage(manifest.sources[JOURNEY_SOURCE]?.coveredRanges ?? [], from, to);
                    const entries = readRange(archiveRoot, JOURNEY_SOURCE, from, to);
                    rawFetched = entries.length;
                    for (const e of entries) {
                        if (allEvents.length >= cap) { truncated = true; break; }
                        const payload = e.payload ?? {};
                        const evName = (payload as Record<string, unknown>).eventName;
                        if (typeof evName === "string") {
                            eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
                        }
                        if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
                        allEvents.push({ timestamp: e.timestamp, payload: payload as RawAuthEvent["payload"] });
                    }
                    send({ type: "progress", page: 1, rawFetched, matched: allEvents.length, truncated });
                } else {
                    while (pages < MAX_PAGES) {
                        pages++;
                        const params = new URLSearchParams({
                            source: JOURNEY_SOURCE,
                            beginTime: from,
                            endTime: to,
                            _queryFilter: broadFilter,
                            ...(cookie ? { _pagedResultsCookie: cookie } : {}),
                        });
                        const url = `${tenantBaseUrl}/monitoring/logs?${params}`;
                        const res = await fetch(url, { headers: authHeaders });
                        if (!res.ok) {
                            const text = await res.text();
                            send({ type: "error", error: `HTTP ${res.status}: ${text}` });
                            controller.close();
                            return;
                        }
                        const data = (await res.json()) as {
                            result?: Array<{ timestamp?: string; payload?: unknown }>;
                            // CREST asymmetry: request param is `_pagedResultsCookie`,
                            // RESPONSE field is `pagedResultsCookie` (no underscore).
                            pagedResultsCookie?: string | null;
                        };
                        const page = Array.isArray(data.result) ? data.result : [];
                        rawFetched += page.length;
                        for (const r of page) {
                            if (allEvents.length >= cap) { truncated = true; break; }
                            if (!r.timestamp) continue;
                            const payload = r.payload ?? {};
                            if (typeof payload === "object" && payload !== null) {
                                const evName = (payload as Record<string, unknown>).eventName;
                                if (typeof evName === "string") {
                                    eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
                                }
                                if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
                            }
                            allEvents.push({ timestamp: r.timestamp, payload: payload as RawAuthEvent["payload"] });
                        }
                        send({ type: "progress", page: pages, rawFetched, matched: allEvents.length, truncated });
                        if (truncated) break;
                        cookie = data.pagedResultsCookie ?? undefined;
                        if (!cookie) break;
                    }
                }

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

                const report = analyzeJourneyHistory(analyzed);
                if (truncated || (source === "live" && pages >= MAX_PAGES)) report.truncated = true;
                const topEventNames = Array.from(eventNameCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 20)
                    .map(([name, count]) => ({ name, count }));
                send({
                    type: "done",
                    ...report,
                    window: { from, to },
                    env,
                    source,
                    coverage,
                    pagesFetched: pages,
                    eventsFetched: analyzed.length,
                    rawFetched,
                    topEventNames,
                });
                controller.close();
            } catch (err) {
                try {
                    send({ type: "error", error: String(err) });
                    controller.close();
                } catch {
                    // Stream already closed / client disconnected — nothing to do.
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
        },
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/analyze/journey-history/route.test.ts`
Expected: PASS (the new archive test + all existing live/pagination tests).

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/api/analyze/journey-history/
```
Expected: `tsc` clean (whole project); eslint clean.

- [ ] **Step 6: Commit** (stage ONLY these two files)

```bash
git add src/app/api/analyze/journey-history/route.ts src/app/api/analyze/journey-history/route.test.ts
git commit -m "feat(journey): read journey events from the local archive (source=archive) + env allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Journey panel — Live | Archive toggle + coverage banner

**Files:**
- Modify: `src/app/analyze/JourneyHistoryPanel.tsx`

This is a React client component; per repo convention (`.tsx` excluded from unit tests) it's verified by `tsc` + `eslint`, not Vitest.

- [ ] **Step 1: Extend the report type and add a source state**

In `src/app/analyze/JourneyHistoryPanel.tsx`, find the `ScanReport` type and add the two new fields the route now returns:

```typescript
type ScanReport = JourneyHistoryReport & {
    window?: { from: string; to: string };
    env?: string;
    eventsFetched?: number;
    pagesFetched?: number;
    rawFetched?: number;
    topEventNames?: { name: string; count: number }[];
    source?: "live" | "archive";
    coverage?: "full" | "partial" | "none";
};
```

Find the state declarations block (where `env`, `from`, `to`, `treeName`, `scope`, `maxEvents` are declared via `useState`) and add:

```typescript
    const [dataSource, setDataSource] = useState<"live" | "archive">("live");
```

- [ ] **Step 2: Send `source` in the request**

In `run()`, find the `body: JSON.stringify({ ... })` for the POST to `/api/analyze/journey-history` and add `source: dataSource` to the object, e.g.:

```typescript
                body: JSON.stringify({
                    env,
                    from: localToIso(from),
                    to: localToIso(to),
                    treeName: treeName.trim() || undefined,
                    maxEvents,
                    source: dataSource,
                }),
```

- [ ] **Step 3: Add the Live | Archive toggle to the form**

Find the form controls row (where the "Scope" and "Max events" `<label>`s are). Add this control alongside them (place it before the "Max events" label):

```tsx
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Source</span>
                        <select
                            value={dataSource}
                            onChange={(e) => setDataSource(e.target.value as "live" | "archive")}
                            className="rounded border border-slate-300 px-2 py-1.5 bg-white"
                        >
                            <option value="live">Live (AIC)</option>
                            <option value="archive">Local archive</option>
                        </select>
                    </label>
```

- [ ] **Step 4: Add a coverage banner**

Find where the results render (just inside `{report && scopedSummary ? ( <> ... )`, right before the stats grid `<div className="grid ...">`). Insert:

```tsx
                    {report.source === "archive" && report.coverage && report.coverage !== "full" ? (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            {report.coverage === "none"
                                ? "This window isn't in the local archive yet — run a log pull for this range, or switch Source to Live (AIC)."
                                : "The local archive only partially covers this window — results may be incomplete. Pull the missing range, or switch to Live (AIC)."}
                        </div>
                    ) : report.source === "archive" ? (
                        <div className="text-xs text-slate-500">Served from the local archive.</div>
                    ) : null}
```

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/analyze/JourneyHistoryPanel.tsx
```
Expected: `tsc` clean; eslint clean.

- [ ] **Step 6: Commit** (stage ONLY this file)

```bash
git add src/app/analyze/JourneyHistoryPanel.tsx
git commit -m "feat(journey): Live | Archive source toggle + archive coverage banner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase A3

- `POST /api/analyze/journey-history` accepts `source: "live" | "archive"`; archive reads `am-authentication` from the local store, runs the same analyzer + treeName filter + diagnostics, and reports `coverage` (`full`/`partial`/`none`); env is allowlisted.
- The journey panel has a Live | Archive toggle and shows a coverage banner for archive runs.
- `rangeCoverage` is unit-tested; the route's archive branch is unit-tested (mocked `readRange`); the panel is tsc/eslint-verified.
- Full Vitest suite green; `tsc --noEmit` + `eslint` clean.

## Manual smoke test

1. Pull a window into the archive (Phase A2b): `POST /api/logs/archive/pull` with `{env, sources:["am-authentication"], from, to}`; wait for the job to complete.
2. In the Journey panel, set the same window, choose **Source = Local archive**, Run report. Expect results instantly with no truncation and "Served from the local archive."
3. Choose a window NOT pulled → expect the amber "isn't in the local archive yet" banner.

## Self-review notes (author)

- **Spec coverage:** Live|Archive toggle ✓; archive reads via `readRange` and runs the unchanged analyzer ✓; coverage surfaced from the manifest ✓; same response shape (streamed `done`) so Scan details/rollup/attempts all work for both sources ✓.
- **Bonus hardening:** env allowlist added to this route (closes the pre-existing path-traversal pattern the security review flagged), now that we're editing it.
- **Placeholder scan:** none — full route file + exact panel edits.
- **Type consistency:** `rangeCoverage` (manifest), `readRange`/`readManifest`/`logDataDir` (A1), `source`/`coverage` on `ScanReport` ↔ `done` message all line up.
- **Deferred:** a dedicated pull UI (A2c) and the explore layer (B). Archive reads load the window into memory (fine for a day/few-day window; streaming/iterating is a future concern for very large windows).
