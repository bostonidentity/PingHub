# Log Archive — Phase E (Skip-Covered Pulling + Live Progress) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop re-pulling already-archived ranges (skip the covered contiguous prefix; record coverage incrementally as pages stream), and show the current event timestamp + truncated message on the pull job card. Global `_id` dedup stays (lossless — verified unique).

**Architecture:** `runLogPull` records coverage up to the last-stored event timestamp after each page (events arrive ascending), and at each source's start trims `[from,to]` past the already-covered prefix (fully covered → skip the source). Dedup remains the safety net for any non-prefix overlap. Per-source progress gains `lastTimestamp` + `lastMessage`, displayed on the card.

**Tech Stack:** TypeScript, Vitest (runner + manifest are unit-tested), React (`JobCard` via tsc/eslint). Builds on A1/A2a manifest + runner.

**Reference:** probe found AIC pages are ascending (within + across pages), `_pageSize` caps at 1000, and `payload._id` is unique per event.

---

## Task 1: `trimCoveredPrefix` helper

**Files:**
- Modify: `src/lib/logs/manifest.ts`
- Test: `src/lib/logs/manifest.test.ts`

- [ ] **Step 1: Failing tests** — add to `manifest.test.ts` (merge `trimCoveredPrefix` into the existing `./manifest` import):

```typescript
describe("trimCoveredPrefix", () => {
    it("returns `from` when nothing is covered", () => {
        expect(trimCoveredPrefix([], "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T00:00:00Z");
    });
    it("returns null when [from,to] is fully covered", () => {
        const c = [{ from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBeNull();
    });
    it("advances past a covered prefix to the first uncovered point", () => {
        const c = [{ from: "2026-06-02T00:00:00Z", to: "2026-06-02T06:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T06:00:00Z");
    });
    it("merges adjacent covered prefixes", () => {
        const c = [
            { from: "2026-06-02T00:00:00Z", to: "2026-06-02T06:00:00Z" },
            { from: "2026-06-02T06:00:00Z", to: "2026-06-02T12:00:00Z" },
        ];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T12:00:00Z");
    });
    it("does not advance for a mid-window hole that doesn't touch `from`", () => {
        const c = [{ from: "2026-06-02T10:00:00Z", to: "2026-06-02T11:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T00:00:00Z");
    });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run src/lib/logs/manifest.test.ts` (trimCoveredPrefix not exported).

- [ ] **Step 3: Implement** — add to `src/lib/logs/manifest.ts`:

```typescript
/**
 * The earliest point >= `from` not covered by a contiguous prefix of `covered`,
 * or null when [from,to] is entirely covered by that prefix. Used to skip
 * re-pulling already-archived leading ranges. (A mid-window hole that doesn't
 * touch `from` is NOT skipped — it's re-pulled, and dedup keeps that correct.)
 */
export function trimCoveredPrefix(covered: TimeRange[], from: string, to: string): string | null {
    let eff = from;
    let advanced = true;
    while (advanced) {
        advanced = false;
        for (const r of covered) {
            if (r.from <= eff && r.to > eff) { eff = r.to; advanced = true; }
        }
    }
    return eff >= to ? null : eff;
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run src/lib/logs/manifest.test.ts`.

- [ ] **Step 5: Gates** — `npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"`; `npx eslint src/lib/logs/`.

- [ ] **Step 6: Commit**
```bash
git add src/lib/logs/manifest.ts src/lib/logs/manifest.test.ts
git commit -m "feat(logs): trimCoveredPrefix — skip already-covered leading ranges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Runner — skip-covered + incremental coverage + live progress

**Files:**
- Modify: `src/lib/logs/log-job-types.ts` (add progress fields)
- Modify: `src/lib/logs/log-pull-runner.ts`
- Modify: `src/lib/logs/log-pull-runner.test.ts`

- [ ] **Step 1: Add progress fields** — in `src/lib/logs/log-job-types.ts`, add to `LogSourceProgress`:
```typescript
    /** Timestamp of the most recently stored event (live progress display). */
    lastTimestamp?: string;
    /** Short summary of the most recent event (eventName·result, or raw text). */
    lastMessage?: string;
```

- [ ] **Step 2: Update the runner.** In `src/lib/logs/log-pull-runner.ts`:

(a) Add `trimCoveredPrefix` to the manifest import:
```typescript
import { readManifest, writeManifest, addCoveredRange, trimCoveredPrefix } from "./manifest";
```

(b) Add a module-level `summarizeEntry` helper (near the top, after the constants):
```typescript
/** A short, single-line summary of an event for the progress display. */
function summarizeEntry(entry: { payload?: unknown }): string {
    const p = entry?.payload;
    if (typeof p === "string") return p.slice(0, 120);
    if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const parts = [o.eventName, o.result].filter((v): v is string => typeof v === "string" && v.length > 0);
        if (parts.length) return parts.join(" · ").slice(0, 120);
        if (typeof o.message === "string") return o.message.slice(0, 120);
    }
    return "";
}
```

(c) In the per-source body, BEFORE the page loop (right after `registry.updateProgress(job.id, source, { status: "running" });` and the `let cookie/fetched/stored/...` declarations), compute the effective start by trimming covered prefix:
```typescript
        // Skip the already-covered contiguous prefix of [from,to]. Fully covered → done.
        const coverage0 = readManifest(archiveRoot).sources[source]?.coveredRanges ?? [];
        const effFrom = trimCoveredPrefix(coverage0, job.from, job.to);
        if (effFrom === null) {
            registry.updateProgress(job.id, source, { status: "done" });
            continue;
        }
```
(Place this so `effFrom` is in scope for the page loop. On a cookie-resume, AIC ignores `beginTime` when a cookie is present, so using `effFrom` as `beginTime` is safe and consistent.)

(d) In the page-loop `URLSearchParams`, change `beginTime: job.from` to `beginTime: effFrom`.

(e) After `const appended = appendEntries(...)` and the `fetched/stored/storedThisRun` updates, replace the existing `registry.updateProgress(job.id, source, { fetched, stored, cookie });` with incremental-coverage + live-progress logic:
```typescript
                const last = entries.length ? entries[entries.length - 1] : undefined;
                const lastTs = typeof last?.timestamp === "string" ? last.timestamp : undefined;
                const lastMessage = last ? summarizeEntry(last) : undefined;
                // Extend coverage up to the last stored event (events arrive ascending).
                if (lastTs) {
                    try {
                        const m = readManifest(archiveRoot);
                        writeManifest(archiveRoot, addCoveredRange(m, source, { from: job.from, to: lastTs }));
                    } catch { /* manifest write best-effort; completion write below is the backstop */ }
                }
                registry.updateProgress(job.id, source, { fetched, stored, cookie, lastTimestamp: lastTs, lastMessage });
```
(Leave the rest of the loop — `if (!cookie) break;`, pace, heap-suspend — unchanged. Keep the existing completion block that, on `!sourceFailed && cookie === null`, writes coverage `[job.from, job.to]`, sets `entryCount`, and marks the source `done`.)

- [ ] **Step 3: Update + add runner tests** in `src/lib/logs/log-pull-runner.test.ts`:

(i) The existing **"dedupes on a re-pull of the same window"** test now SKIPS (covered prefix) instead of re-fetching. Replace its body's second-job assertion: after the first job completes and records coverage, the second job should NOT call fetch and should mark the source done. Update it to:
```typescript
    it("skips a source whose window is already fully covered (no re-fetch)", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const pages = () => pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: null },
        ]);
        const job1 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        await runLogPull({ ...baseOpts(root), job: job1, registry: reg, fetchFn: pages() });
        reg.setJobStatus(job1.id, "completed");

        const job2 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetch2 = pages();
        await runLogPull({ ...baseOpts(root), job: job2, registry: reg, fetchFn: fetch2 });

        expect(fetch2).not.toHaveBeenCalled();                       // already covered → no re-fetch
        expect(reg.getJob(job2.id)!.progress[0].status).toBe("done");
        const stored = readRange(baseOpts(root).archiveRoot, "am-authentication", FROM, TO);
        expect(stored).toHaveLength(1);                              // not duplicated
    });
```

(ii) Add a test that the first page sets `lastTimestamp`/`lastMessage` and that incremental coverage is recorded:
```typescript
    it("records lastTimestamp/lastMessage and extends coverage incrementally", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetchFn = pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z"), logEntry("b", "2026-06-02T02:00:00Z")], pagedResultsCookie: "c2" },
            { result: [logEntry("c", "2026-06-02T03:00:00Z")], pagedResultsCookie: null },
        ]);
        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });
        const p = reg.getJob(job.id)!.progress[0];
        expect(p.lastTimestamp).toBe("2026-06-02T03:00:00Z");
        expect(typeof p.lastMessage).toBe("string");
        const manifest = readManifest(baseOpts(root).archiveRoot);
        expect(manifest.sources["am-authentication"].coveredRanges).toEqual([{ from: FROM, to: TO }]);
    });

    it("resumes from the uncovered point after a prior partial window", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        // First job covers [FROM, 2026-06-02T02:00:00Z]
        const j1 = reg.startJob("prod", ["am-authentication"], FROM, "2026-06-02T02:00:00Z");
        await runLogPull({ ...baseOpts(root), job: j1, registry: reg, fetchFn: pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: null },
        ]) });
        reg.setJobStatus(j1.id, "completed");
        // Second job extends to TO — should begin at the covered prefix end.
        const j2 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const seen: string[] = [];
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => { seen.push(String(url)); return jsonRes({ result: [logEntry("z", "2026-06-02T05:00:00Z")], pagedResultsCookie: null }); });
        await runLogPull({ ...baseOpts(root), job: j2, registry: reg, fetchFn });
        expect(seen[0]).toContain(`beginTime=${encodeURIComponent("2026-06-02T02:00:00Z")}`);
        expect(reg.getJob(j2.id)!.progress[0].status).toBe("done");
    });
```
(Reuse the file's existing `pagingFetch`, `jsonRes`, `logEntry`, `baseOpts`, `tmpEnvsRoot`, `FROM`, `TO`, `readRange`, `readManifest` helpers/imports; add any missing import like `readManifest` from `./manifest`.)

(iii) Re-check other existing runner tests still pass (fresh archive → `effFrom === job.from`, so paging/suspend/abort/failure behavior is unchanged). Fix any that asserted on the old re-pull behavior.

- [ ] **Step 4: Verify** — `npx vitest run src/lib/logs/`; `npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"`; `npx eslint src/lib/logs/`. All green.

- [ ] **Step 5: Commit**
```bash
git add src/lib/logs/log-job-types.ts src/lib/logs/log-pull-runner.ts src/lib/logs/log-pull-runner.test.ts
git commit -m "feat(logs): skip covered prefix, incremental coverage, live ts/message progress

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Show timestamp + message on the job card

**Files:**
- Modify: `src/app/data/pull/LogPullView.tsx`

The generalized `JobCardRow` already has a `detail` field. In `toLogModel` (in `LogPullView.tsx`), enrich each row's `detail` with the live timestamp + message for the active source.

- [ ] **Step 1:** In `toLogModel`, change the per-source row mapping so `detail` shows progress. Replace the `progress: job.progress.map(...)` body with:
```typescript
        progress: job.progress.map((p) => {
            const live = p.status === "running" && p.lastTimestamp
                ? `${new Date(p.lastTimestamp).toLocaleTimeString()} · ${p.lastMessage ?? ""}`.trim()
                : `${p.stored.toLocaleString()} stored`;
            return {
                label: p.source,
                fetched: p.fetched,
                expected: null,
                status: p.status,
                error: p.error,
                detail: live,
            };
        }),
```
(`LogSourceProgress.lastTimestamp`/`lastMessage` are now available from Task 2.)

- [ ] **Step 2: Gates** — `npx tsc --noEmit`; `npx eslint src/app/data/pull/LogPullView.tsx`.

- [ ] **Step 3: Full verification** — `npx vitest run`; `npx tsc --noEmit`; `npx eslint src/lib/logs/ src/app/data/pull/`; `npx next build` (succeeds).

- [ ] **Step 4: Commit**
```bash
git add src/app/data/pull/LogPullView.tsx
git commit -m "feat(logs): show live event timestamp + message on the pull card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria
- Re-pulling a fully-covered window fetches nothing (source marked done); extending a window begins at the covered prefix end; mid-window holes are re-pulled but dedup keeps them correct.
- Coverage is recorded incrementally up to the last-stored event timestamp (ascending), so partial/suspended pulls register accurate coverage.
- Global `_id` dedup unchanged; per-source progress carries `lastTimestamp`/`lastMessage`; the pull card shows the running source's current time + truncated message.
- `npx vitest run` green; `tsc` + `eslint` clean; `next build` succeeds.

## Self-review notes
- `_id` dedup verified lossless (unique per event) → safe to keep; it's the integrity backstop for any non-prefix overlap.
- Skip-covered uses a contiguous-prefix trim (not full multi-gap) — covers re-pull-same (skip) + extend/catch-up (resume point); middle holes re-fetch (dedup-safe), a fair simplicity tradeoff.
- Incremental coverage + per-page manifest write is best-effort (try/catch) with the on-completion write as backstop; cookie resume stays consistent because coverage and cursor advance together per page.
- Runner is unit-tested (mock fetch); the card is a `.tsx` change (tsc/eslint/build).
