# Log Archive — Phase A2a (Pull Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rate-limit-aware, resumable engine that pulls AIC logs for a time window into the Phase A1 storage core — as pure, mock-fetch-testable libraries (no HTTP routes or UI yet).

**Architecture:** A `LogPullJob` (per-source progress, persisted under `log-data/.jobs/`) plus a `runLogPull` orchestrator that pages AIC `/monitoring/logs` per source, throttles to AIC's ~60-req/window limit (proactive pacing from `x-ratelimit-*` headers + reactive `429`/`Retry-After` backoff), feeds each page to `appendEntries` (A1), advances the manifest's covered range on source completion, resumes from the saved paged-results cookie, and self-suspends under heap pressure. All time/sleep/fetch is injectable so the engine is deterministically testable. Mirrors the existing `src/lib/data/{job-registry,pull-runner}.ts` conventions, adapted for log-API auth (`x-api-key`/`x-api-secret`) and `_id`-based dedup (so no NDJSON truncate-on-resume is needed).

**Tech Stack:** TypeScript, Node `fs`/`v8`, Vitest. Builds on `src/lib/logs/` (A1): `appendEntries`, `readManifest`/`writeManifest`/`addCoveredRange`, `logDataDir`.

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md`
**Builds on:** `docs/superpowers/plans/2026-06-03-log-archive-phase-a1-storage-core.md` (DONE — `src/lib/logs/` storage core)

**Measured constraints driving this design (from the spec's timing baseline):**
- AIC rate limit ≈ **60 requests/window**; headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (epoch seconds); over-limit → **HTTP 429 + `Retry-After: 3`**.
- **No total count** (`totalPagedResults: -1`) → progress is fetched-so-far only, never a percentage.
- Response cursor field is **`pagedResultsCookie`** (no underscore); request param is `_pagedResultsCookie`.
- Dedup key is **`payload._id`** (handled inside A1's `appendEntries`).

---

## File Structure

New files under `src/lib/logs/`:

- `log-job-types.ts` — `LogJobStatus`, `LogSourceProgress`, `LogPullJob`. Declarations only.
- `log-job-registry.ts` — `LogRegistry` interface + `createLogRegistry(envsRoot)` + `getLogRegistry()` singleton. Job lifecycle + persistence under `{env}/log-data/.jobs/`. Mirrors `src/lib/data/job-registry.ts`.
- `log-fetch.ts` — `fetchLogPage` (429/Retry-After retry) + `paceDelayMs` (proactive pacing from rate-limit headers). Pure/injectable; the throttling brain.
- `log-pull-runner.ts` — `runLogPull(opts)` orchestrator: pages each source, stores via `appendEntries`, paces, resumes, updates manifest, heap-suspends.

This phase deliberately stops before HTTP routes and UI (Phase **A2b**) and before the journey-report archive toggle (Phase **A3**).

---

## Task 1: Log job types + registry

**Files:**
- Create: `src/lib/logs/log-job-types.ts`
- Create: `src/lib/logs/log-job-registry.ts`
- Test: `src/lib/logs/log-job-registry.test.ts`

- [ ] **Step 1: Write the types file** (no test — declarations)

Create `src/lib/logs/log-job-types.ts`:

```typescript
export type LogJobStatus =
    | "queued"
    | "running"
    | "aborting"
    | "completed"
    | "failed"
    | "aborted"
    | "interrupted"
    | "suspending"
    | "suspended";

export interface LogSourceProgress {
    source: string;
    status: "pending" | "running" | "done" | "failed";
    /** Raw entries pulled from AIC for this source (cumulative across resumes). */
    fetched: number;
    /** Newly stored (deduped) entries for this source (cumulative). */
    stored: number;
    /** Last persisted pagedResultsCookie. null = source exhausted; undefined = not started. */
    cookie?: string | null;
    error?: string;
}

export interface LogPullJob {
    id: string;
    env: string;
    sources: string[];
    /** ISO window pulled for every source in this job. */
    from: string;
    to: string;
    startedAt: number;
    finishedAt?: number;
    status: LogJobStatus;
    progress: LogSourceProgress[];
    fatalError?: string;
}
```

- [ ] **Step 2: Write the failing test** — create `src/lib/logs/log-job-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogRegistry, LogJobConflictError } from "./log-job-registry";

function tmpEnvsRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-jobs-"));
}

const WINDOW = { from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" };

describe("log-job-registry", () => {
    it("startJob creates a job with per-source pending progress and persists it", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication", "am-access"], WINDOW.from, WINDOW.to);
        expect(job.status).toBe("queued");
        expect(job.from).toBe(WINDOW.from);
        expect(job.progress.map((p) => p.source)).toEqual(["am-authentication", "am-access"]);
        expect(job.progress.every((p) => p.status === "pending" && p.fetched === 0 && p.stored === 0)).toBe(true);
        // Persisted to disk under {env}/log-data/.jobs/{id}.json
        const f = path.join(root, "prod", "log-data", ".jobs", `${job.id}.json`);
        expect(fs.existsSync(f)).toBe(true);
    });

    it("rejects a second active job for the same env", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        expect(() => reg.startJob("prod", ["am-access"], WINDOW.from, WINDOW.to)).toThrow(LogJobConflictError);
    });

    it("allows a new job once the prior one is terminal", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const a = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.setJobStatus(a.id, "completed");
        expect(() => reg.startJob("prod", ["am-access"], WINDOW.from, WINDOW.to)).not.toThrow();
    });

    it("updateProgress patches a source and persists", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.updateProgress(job.id, "am-authentication", { status: "running", fetched: 100, stored: 90, cookie: "c1" });
        const reloaded = JSON.parse(
            fs.readFileSync(path.join(root, "prod", "log-data", ".jobs", `${job.id}.json`), "utf-8"),
        );
        expect(reloaded.progress[0]).toMatchObject({ status: "running", fetched: 100, stored: 90, cookie: "c1" });
    });

    it("setJobStatus to terminal stamps finishedAt", () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg.setJobStatus(job.id, "failed", "boom");
        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("failed");
        expect(j.fatalError).toBe("boom");
        expect(typeof j.finishedAt).toBe("number");
    });

    it("on construction, marks a persisted non-terminal job as interrupted (but leaves suspended)", () => {
        const root = tmpEnvsRoot();
        const reg1 = createLogRegistry(root);
        const running = reg1.startJob("prod", ["am-authentication"], WINDOW.from, WINDOW.to);
        reg1.setJobStatus(running.id, "running");
        const suspended = reg1.startJob("uat", ["am-access"], WINDOW.from, WINDOW.to);
        reg1.setJobStatus(suspended.id, "suspended");

        // Simulate a server restart: a fresh registry over the same root.
        const reg2 = createLogRegistry(root);
        expect(reg2.getJob(running.id)!.status).toBe("interrupted");
        expect(reg2.getJob(suspended.id)!.status).toBe("suspended");
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-job-registry.test.ts`
Expected: FAIL — Cannot find module './log-job-registry'.

- [ ] **Step 4: Implement** — create `src/lib/logs/log-job-registry.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import type { LogJobStatus, LogPullJob, LogSourceProgress } from "./log-job-types";

const TERMINAL: LogJobStatus[] = ["completed", "failed", "aborted"];

export class LogJobConflictError extends Error {
    constructor(public existingJobId: string) {
        super(`Log pull already active for env (id=${existingJobId})`);
        this.name = "LogJobConflictError";
    }
}

export interface LogRegistry {
    startJob(env: string, sources: string[], from: string, to: string): LogPullJob;
    getJob(id: string): LogPullJob | undefined;
    getActiveJobForEnv(env: string): LogPullJob | undefined;
    listJobs(opts: { env?: string; includeFinished: boolean }): LogPullJob[];
    updateProgress(id: string, source: string, patch: Partial<LogSourceProgress>): void;
    setJobStatus(id: string, status: LogJobStatus, fatalError?: string): void;
}

function jobsDir(envsRoot: string, env: string): string {
    return path.join(envsRoot, env, "log-data", ".jobs");
}

function writeJobFile(envsRoot: string, job: LogPullJob): void {
    const dir = jobsDir(envsRoot, job.env);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${job.id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
    fs.renameSync(tmpPath, finalPath);
}

function isActive(j: LogPullJob): boolean {
    return !TERMINAL.includes(j.status);
}

export function createLogRegistry(envsRoot: string): LogRegistry {
    const byId = new Map<string, LogPullJob>();

    // Restart cleanup: load persisted jobs; mark non-terminal as interrupted so
    // a resume can pick up from each source's saved cookie. A user-suspended
    // job stays suspended.
    if (fs.existsSync(envsRoot)) {
        for (const envEntry of fs.readdirSync(envsRoot, { withFileTypes: true })) {
            if (!envEntry.isDirectory()) continue;
            const dir = jobsDir(envsRoot, envEntry.name);
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith(".json")) continue;
                try {
                    const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as LogPullJob;
                    if (isActive(job) && job.status !== "suspended") {
                        job.status = "interrupted";
                        writeJobFile(envsRoot, job);
                    }
                    byId.set(job.id, job);
                } catch { /* skip unreadable */ }
            }
        }
    }

    return {
        startJob(env, sources, from, to) {
            for (const j of byId.values()) {
                if (j.env === env && isActive(j)) throw new LogJobConflictError(j.id);
            }
            const job: LogPullJob = {
                id: randomUUID(),
                env,
                sources,
                from,
                to,
                startedAt: Date.now(),
                status: "queued",
                progress: sources.map((s) => ({ source: s, status: "pending", fetched: 0, stored: 0 })),
            };
            byId.set(job.id, job);
            writeJobFile(envsRoot, job);
            return job;
        },
        getJob(id) { return byId.get(id); },
        getActiveJobForEnv(env) {
            for (const j of byId.values()) {
                if (j.env === env && isActive(j)) return j;
            }
            return undefined;
        },
        listJobs({ env, includeFinished }) {
            return [...byId.values()]
                .filter((j) => (env ? j.env === env : true))
                .filter((j) => (includeFinished ? true : isActive(j)))
                .sort((a, b) => b.startedAt - a.startedAt)
                .slice(0, 20);
        },
        updateProgress(id, source, patch) {
            const job = byId.get(id);
            if (!job) return;
            const p = job.progress.find((p) => p.source === source);
            if (!p) return;
            Object.assign(p, patch);
            writeJobFile(envsRoot, job);
        },
        setJobStatus(id, status, fatalError) {
            const job = byId.get(id);
            if (!job) return;
            job.status = status;
            if (fatalError) job.fatalError = fatalError;
            if (TERMINAL.includes(status)) job.finishedAt = Date.now();
            writeJobFile(envsRoot, job);
        },
    };
}

// Module-level singleton for API routes (Phase A2b). Stored on globalThis so it
// survives Next.js HMR in dev (a plain module var resets on hot-reload and would
// orphan in-flight runLogPull promises).
const _global = globalThis as typeof globalThis & { __logJobRegistry?: LogRegistry };
export function getLogRegistry(): LogRegistry {
    if (!_global.__logJobRegistry) _global.__logJobRegistry = createLogRegistry(ENVIRONMENTS_DIR);
    return _global.__logJobRegistry;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-job-registry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + lint gates**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: "no logs type errors"; eslint clean.

- [ ] **Step 7: Commit** (stage ONLY these three files; the working tree has unrelated uncommitted changes)

```bash
git add src/lib/logs/log-job-types.ts src/lib/logs/log-job-registry.ts src/lib/logs/log-job-registry.test.ts
git commit -m "feat(logs): log pull job types + registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rate-limit-aware fetch helper

**Files:**
- Create: `src/lib/logs/log-fetch.ts`
- Test: `src/lib/logs/log-fetch.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/lib/logs/log-fetch.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchLogPage, paceDelayMs } from "./log-fetch";

/** Minimal Response stub with just the surface log-fetch reads. */
function res(status: number, headers: Record<string, string> = {}): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
        text: async () => "",
    } as unknown as Response;
}

describe("fetchLogPage", () => {
    it("returns immediately on a 200", async () => {
        const fetchFn = vi.fn().mockResolvedValue(res(200));
        const r = await fetchLogPage("http://x", {}, { fetchFn });
        expect(r.status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("retries on 429 honoring Retry-After, then succeeds", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, { "retry-after": "3" }))
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const sleepFn = async (ms: number) => { sleeps.push(ms); };
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn });
        expect(r.status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(sleeps).toEqual([3000]); // Retry-After seconds → ms
    });

    it("falls back to exponential backoff when Retry-After is absent", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429))
            .mockResolvedValueOnce(res(429))
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(r.status).toBe(200);
        expect(sleeps).toEqual([2000, 4000]); // 1000 * 2^attempt
    });

    it("gives up after maxRetries and returns the last 429", async () => {
        const fetchFn = vi.fn().mockResolvedValue(res(429, { "retry-after": "1" }));
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async () => {}, maxRetries: 2 });
        expect(r.status).toBe(429);
        expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
});

describe("paceDelayMs", () => {
    it("returns 0 when remaining is healthy", () => {
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "30", "x-ratelimit-reset": "1000" }), 0)).toBe(0);
    });

    it("waits until reset when remaining is exhausted", () => {
        // reset = 1000s epoch → 1_000_000 ms; now = 400_000 ms → wait 600_000 ms.
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }), 400_000)).toBe(600_000);
    });

    it("never returns a negative wait", () => {
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1000" }), 2_000_000)).toBe(0);
    });

    it("returns 0 when headers are missing", () => {
        expect(paceDelayMs(res(200), 0)).toBe(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-fetch.test.ts`
Expected: FAIL — Cannot find module './log-fetch'.

- [ ] **Step 3: Implement** — create `src/lib/logs/log-fetch.ts`:

```typescript
const DEFAULT_MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 30_000;
/** Pace proactively once remaining headroom drops to this many requests. */
const PACE_THRESHOLD = 1;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchLogPageOpts {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    sleepFn?: (ms: number) => Promise<void>;
    maxRetries?: number;
    /** Called each time a 429 forces a backoff (for progress/telemetry). */
    onThrottle?: (waitMs: number, attempt: number) => void;
}

/**
 * Fetch one page, retrying on HTTP 429. Honors a `Retry-After` header (seconds);
 * otherwise backs off exponentially (1s·2^attempt, capped). After `maxRetries`
 * exhausted retries it returns the last (429) response so the caller can decide.
 */
export async function fetchLogPage(
    url: string,
    headers: Record<string, string>,
    opts: FetchLogPageOpts = {},
): Promise<Response> {
    const fetchFn = opts.fetchFn ?? fetch;
    const sleepFn = opts.sleepFn ?? defaultSleep;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

    let attempt = 0;
    for (;;) {
        const res = await fetchFn(url, { headers, signal: opts.signal });
        if (res.status !== 429) return res;
        attempt++;
        if (attempt > maxRetries) return res;
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
        opts.onThrottle?.(waitMs, attempt);
        await sleepFn(waitMs);
    }
}

/**
 * Proactive pacing: given a response's rate-limit headers and the current epoch
 * time in ms, return how long to wait before the next request to avoid tripping
 * the limit. Returns 0 when there's headroom or the headers are absent.
 *
 * Headers: `x-ratelimit-remaining` (requests left), `x-ratelimit-reset` (epoch
 * SECONDS at which the window resets).
 */
export function paceDelayMs(res: Response, nowMs: number): number {
    const remainingRaw = res.headers.get("x-ratelimit-remaining");
    const resetRaw = res.headers.get("x-ratelimit-reset");
    if (remainingRaw === null || resetRaw === null) return 0;
    const remaining = Number(remainingRaw);
    const resetSec = Number(resetRaw);
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return 0;
    if (remaining > PACE_THRESHOLD) return 0;
    return Math.max(0, resetSec * 1000 - nowMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-fetch.test.ts`
Expected: PASS (fetchLogPage: 4, paceDelayMs: 4).

- [ ] **Step 5: Typecheck + lint gates**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: "no logs type errors"; eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-fetch.ts src/lib/logs/log-fetch.test.ts
git commit -m "feat(logs): rate-limit-aware page fetch (429/Retry-After + proactive pacing)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `runLogPull` orchestrator

**Files:**
- Create: `src/lib/logs/log-pull-runner.ts`
- Test: `src/lib/logs/log-pull-runner.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/lib/logs/log-pull-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runLogPull } from "./log-pull-runner";
import { createLogRegistry } from "./log-job-registry";
import { readManifest } from "./manifest";
import { readRange } from "./log-archive-store";

function tmpEnvsRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-run-"));
}

const FROM = "2026-06-02T00:00:00Z";
const TO = "2026-06-03T00:00:00Z";

/** Minimal Response stub. */
function jsonRes(body: unknown, headers: Record<string, string> = {}): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        status: 200,
        ok: true,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function logEntry(id: string, ts: string) {
    return {
        timestamp: ts,
        source: "am-authentication",
        payload: { _id: id, transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED", level: "INFO", realm: "/alpha", principal: "alice" },
    };
}

/** A fetch mock that pages: page 1 returns a cookie, page 2 (with cookie) ends. */
function pagingFetch(pages: { result: unknown[]; pagedResultsCookie: string | null }[]) {
    let i = 0;
    return vi.fn(async () => jsonRes(pages[Math.min(i++, pages.length - 1)]));
}

const baseOpts = (root: string) => ({
    archiveRoot: path.join(root, "prod", "log-data"),
    tenantBaseUrl: "https://tenant.example.com",
    apiKey: "k",
    apiSecret: "s",
    sleepFn: async () => {},            // no real waiting
    nowMs: () => 0,                     // deterministic pacing
    signal: new AbortController().signal,
    pageSize: 1000,
});

describe("runLogPull", () => {
    it("pages a source to exhaustion, stores entries, and records the covered range", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);

        const fetchFn = pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z"), logEntry("b", "2026-06-02T02:00:00Z")], pagedResultsCookie: "c2" },
            { result: [logEntry("c", "2026-06-02T03:00:00Z")], pagedResultsCookie: null },
        ]);

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });

        // Stored to the archive (deduped) and readable back.
        const stored = readRange(baseOpts(root).archiveRoot, "am-authentication", FROM, TO);
        expect(stored.map((e) => e.payload._id)).toEqual(["a", "b", "c"]);

        // Job + progress finished.
        const done = reg.getJob(job.id)!;
        expect(done.status).toBe("completed");
        expect(done.progress[0]).toMatchObject({ status: "done", fetched: 3, stored: 3, cookie: null });

        // Manifest covered-range + entryCount.
        const manifest = readManifest(baseOpts(root).archiveRoot);
        expect(manifest.sources["am-authentication"].coveredRanges).toEqual([{ from: FROM, to: TO }]);
        expect(manifest.sources["am-authentication"].entryCount).toBe(3);
    });

    it("dedupes on a re-pull of the same window (stored 0, range unchanged)", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);

        const pages = () => pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: null },
        ]);

        const job1 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        await runLogPull({ ...baseOpts(root), job: job1, registry: reg, fetchFn: pages() });
        reg.setJobStatus(job1.id, "completed"); // ensure terminal so a 2nd job is allowed

        const job2 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        await runLogPull({ ...baseOpts(root), job: job2, registry: reg, fetchFn: pages() });

        expect(reg.getJob(job2.id)!.progress[0]).toMatchObject({ fetched: 1, stored: 0 });
        const stored = readRange(baseOpts(root).archiveRoot, "am-authentication", FROM, TO);
        expect(stored).toHaveLength(1); // not duplicated
    });

    it("marks a source failed on a non-2xx page and still completes the job", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetchFn = vi.fn(async () => ({
            status: 500, ok: false,
            headers: { get: () => null },
            text: async () => "server error",
            json: async () => ({}),
        } as unknown as Response));

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });

        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("completed");
        expect(j.progress[0].status).toBe("failed");
        expect(j.progress[0].error).toContain("500");
    });

    it("does nothing and marks aborted when the signal is already aborted", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const ac = new AbortController();
        ac.abort();
        const fetchFn = vi.fn();

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ac.signal });

        expect(fetchFn).not.toHaveBeenCalled();
        expect(reg.getJob(job.id)!.status).toBe("aborted");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-pull-runner.test.ts`
Expected: FAIL — Cannot find module './log-pull-runner'.

- [ ] **Step 3: Implement** — create `src/lib/logs/log-pull-runner.ts`:

```typescript
import v8 from "node:v8";
import { appendEntries } from "./log-archive-store";
import { readManifest, writeManifest, addCoveredRange } from "./manifest";
import { fetchLogPage, paceDelayMs } from "./log-fetch";
import type { LogPullJob } from "./log-job-types";
import type { LogRegistry } from "./log-job-registry";
import type { RawLogEntry } from "./log-types";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_HEAP_SUSPEND_FRACTION = 0.7;

function heapUnderPressure(fraction: number): boolean {
    const { heap_size_limit, used_heap_size } = v8.getHeapStatistics();
    if (!heap_size_limit) return false;
    return used_heap_size / heap_size_limit >= fraction;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunLogPullOpts {
    job: LogPullJob;
    registry: LogRegistry;
    /** `ENVIRONMENTS_DIR/{env}/log-data`. */
    archiveRoot: string;
    tenantBaseUrl: string;
    apiKey: string;
    apiSecret: string;
    signal: AbortSignal;
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    /** Current epoch ms — injected for deterministic pacing in tests. */
    nowMs?: () => number;
    pageSize?: number;
}

/**
 * Pull each source's logs for the job's [from,to] window into the archive.
 *
 * Per source: page AIC `/monitoring/logs` (cursor = `pagedResultsCookie`),
 * store each page via `appendEntries` (dedup by `payload._id`), pace under the
 * rate limit, and on full exhaustion fold [from,to] into the manifest's covered
 * ranges. Resumes from a source's saved cookie; dedup makes re-pulled pages
 * harmless. Self-suspends under heap pressure (cookie persisted for resume).
 */
export async function runLogPull(opts: RunLogPullOpts): Promise<void> {
    const {
        job, registry, archiveRoot, tenantBaseUrl, apiKey, apiSecret, signal,
        fetchFn = fetch,
        sleepFn = defaultSleep,
        nowMs = () => Date.now(),
        pageSize = DEFAULT_PAGE_SIZE,
    } = opts;

    const base = tenantBaseUrl.replace(/\/+$/, "");
    const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret };

    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "running");

    for (const source of job.sources) {
        if (signal.aborted) break;
        const progress = job.progress.find((p) => p.source === source);
        if (progress?.status === "done") continue;

        registry.updateProgress(job.id, source, { status: "running" });

        let cookie: string | null = progress?.cookie ?? null;
        let fetched = progress?.fetched ?? 0;
        let stored = progress?.stored ?? 0;
        let storedThisRun = 0;
        let sourceFailed = false;
        let suspended = false;

        for (;;) {
            if (signal.aborted) break;

            const params = new URLSearchParams({
                source,
                beginTime: job.from,
                endTime: job.to,
                _pageSize: String(pageSize),
            });
            if (cookie) params.set("_pagedResultsCookie", cookie);
            const url = `${base}/monitoring/logs?${params}`;

            const res = await fetchLogPage(url, headers, { fetchFn, signal, sleepFn });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                registry.updateProgress(job.id, source, {
                    status: "failed",
                    error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
                });
                sourceFailed = true;
                break;
            }

            const data = (await res.json()) as { result?: RawLogEntry[]; pagedResultsCookie?: string | null };
            const entries = Array.isArray(data.result) ? data.result : [];
            const appended = appendEntries(archiveRoot, source, entries);
            fetched += entries.length;
            stored += appended.inserted;
            storedThisRun += appended.inserted;
            cookie = data.pagedResultsCookie ?? null;
            registry.updateProgress(job.id, source, { fetched, stored, cookie });

            if (!cookie) break; // source exhausted

            // Pace to stay under the rate limit, then check heap pressure.
            const wait = paceDelayMs(res, nowMs());
            if (wait > 0) await sleepFn(wait);
            if (heapUnderPressure(DEFAULT_HEAP_SUSPEND_FRACTION)) {
                registry.setJobStatus(job.id, "suspending");
                suspended = true;
                break;
            }
        }

        if (suspended) return; // leave cookie persisted; a resume continues
        if (signal.aborted) break;

        if (!sourceFailed && cookie === null) {
            // Source fully covered for [from,to]: fold the range into the manifest.
            const manifest = readManifest(archiveRoot);
            const updated = addCoveredRange(manifest, source, { from: job.from, to: job.to });
            const sm = updated.sources[source];
            sm.entryCount = (sm.entryCount ?? 0) + storedThisRun;
            writeManifest(archiveRoot, updated);
            registry.updateProgress(job.id, source, { status: "done" });
        }
    }

    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "completed");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-pull-runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full verification gates**

Run:
```bash
npx vitest run src/lib/logs/
npx tsc --noEmit
npx eslint src/lib/logs/
```
Expected: all logs tests PASS; `tsc` prints nothing (whole-project clean); eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-pull-runner.ts src/lib/logs/log-pull-runner.test.ts
git commit -m "feat(logs): runLogPull orchestrator (paged, paced, resumable, manifest-aware)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase A2a

- `src/lib/logs/` gains `log-job-types.ts`, `log-job-registry.ts`, `log-fetch.ts`, `log-pull-runner.ts` with co-located tests.
- `npx vitest run src/lib/logs/` green; `tsc --noEmit` and `eslint` clean.
- The engine can, given an injected `fetchFn`: page a source to exhaustion, store deduped entries via A1, pace under the rate limit, retry 429s honoring `Retry-After`, resume from a saved cookie, record covered ranges + `entryCount` in the manifest, mark per-source failures without failing the whole job, and abort/suspend cleanly.
- No HTTP routes, no UI, no real network — those are **Phase A2b** (API routes + minimal pull UI) which will wire `getLogRegistry()` + `runLogPull` behind `POST /api/logs/archive/pull` (streaming progress), `GET /api/logs/archive/jobs`, and suspend/resume endpoints, resolving credentials via `getLogApiCredentials(env)` and `archiveRoot` via `logDataDir(env)`.

## Self-review notes (author)

- **Spec coverage:** rate-limit pacing + 429/Retry-After ✓ (Task 2), no-total progress ✓ (progress is fetched/stored only), `pagedResultsCookie` cursor ✓, `payload._id` dedup ✓ (via A1 appendEntries), incremental covered-range manifest ✓ (Task 3), resumable jobs ✓ (cookie persisted; registry → interrupted on restart), heap-suspend ✓. Streaming progress to the UI and gzip are **A2b/later**, not this plan.
- **Placeholder scan:** none — full code in every step.
- **Type consistency:** `LogPullJob`/`LogSourceProgress`/`LogJobStatus`, `LogRegistry`, `createLogRegistry`/`getLogRegistry`, `fetchLogPage`/`paceDelayMs`, `runLogPull`/`RunLogPullOpts` are consistent across tasks and match A1's `appendEntries`/`readManifest`/`addCoveredRange`/`readRange`/`RawLogEntry` signatures.
- **Known simplification:** `entryCount` accrues `storedThisRun` (genuinely new inserts) per completion, so re-pulls (stored 0) don't inflate it; exact recount from the day DBs is deferred (not needed for A2a).
