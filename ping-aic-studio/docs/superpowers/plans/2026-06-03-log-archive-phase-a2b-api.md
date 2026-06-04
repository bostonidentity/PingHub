# Log Archive — Phase A2b (API Control Plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Phase A2a pull engine over HTTP — start a background log pull, list jobs, read coverage, and suspend/resume — so logs can actually be pulled onto disk for a chosen env + window.

**Architecture:** Mirror the existing data-pull control plane (`src/app/api/data/...`): a `POST /api/logs/archive/pull` validates input, resolves Log-API credentials + tenant URL, starts a `LogPullJob`, and launches `runLogPull` in the background (fire-and-forget) with an `AbortController` held in a shared module-level registry; the client polls `GET /api/logs/archive/jobs`. Suspend flips the job status to `"suspending"` and aborts the controller; the runner finalizes it to the resumable `"suspended"` state. Resume re-launches `runLogPull` for an `interrupted`/`suspended` job from its persisted per-source cookies. Routes are thin glue over the already-tested engine.

**Tech Stack:** Next.js (App Router) route handlers, TypeScript, Vitest. Builds on Phase A2a (`src/lib/logs/log-pull-runner.ts`, `log-job-registry.ts`) and A1 (`logDataDir`, `readManifest`).

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md`
**Builds on:** Phase A1 (storage) + A2a (engine), both DONE under `src/lib/logs/`.
**Pattern source (mirror these):** `src/app/api/data/pull/route.ts`, `src/app/api/data/pull/route-controllers.ts`, `src/app/api/data/jobs/[id]/suspend/route.ts`, `src/app/api/data/pull/jobs/[jobId]/resume/route.ts`. Credentials/tenant resolution mirrors `src/app/api/analyze/journey-history/route.ts` (`getLogApiCredentials` + `getEnvFileContent` + `parseEnvFile`).

---

## Testing note (read before starting)

Task 1 (a change to the tested `runLogPull` engine) is **TDD with unit tests**.

Tasks 2–3 are **thin Next.js route handlers**. This codebase does **not** unit-test background-job route handlers (none exist under `src/app/api/data/...`) because they depend on the `getLogRegistry()` singleton bound to the real `ENVIRONMENTS_DIR` and a fire-and-forget background promise — isolating that in Vitest is brittle and unlike any existing test here. Per "follow existing patterns," these route tasks are verified by **`tsc --noEmit` + `eslint` + a documented `curl` smoke test**, and reviewed for spec-faithfulness against the proven data-pull routes. The real logic they call (`runLogPull`, the registry) is already unit-tested in A2a. Do not invent a brittle singleton-mocking harness.

---

## File Structure

- `src/lib/logs/log-pull-runner.ts` (MODIFY) — on abort, finalize to `"suspended"` if the job status was externally set to `"suspending"`, else `"aborted"`.
- `src/app/api/logs/archive/route-controllers.ts` (CREATE) — shared `AbortController` registry (mirror data's).
- `src/app/api/logs/archive/pull/route.ts` (CREATE) — `POST` start a pull.
- `src/app/api/logs/archive/jobs/route.ts` (CREATE) — `GET` list jobs.
- `src/app/api/logs/archive/manifest/route.ts` (CREATE) — `GET` coverage manifest.
- `src/app/api/logs/archive/jobs/[id]/suspend/route.ts` (CREATE) — `POST` suspend.
- `src/app/api/logs/archive/jobs/[id]/resume/route.ts` (CREATE) — `POST` resume.

UI is deferred to Phase A2c (logs become user-visible via Phase A3's journey Live|Archive toggle regardless).

---

## Task 1: Runner honors an external suspend

**Files:**
- Modify: `src/lib/logs/log-pull-runner.ts`
- Test: `src/lib/logs/log-pull-runner.test.ts`

- [ ] **Step 1: Add the failing tests** — append these two `it(...)` blocks inside the existing `describe("runLogPull", ...)` block in `src/lib/logs/log-pull-runner.test.ts`:

```typescript
    it("finalizes to 'suspended' when an external suspend flips status mid-pull", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const ac = new AbortController();
        // Simulate the suspend endpoint firing during the first page: flip the
        // status to "suspending", then abort the controller.
        const fetchFn = vi.fn(async () => {
            reg.setJobStatus(job.id, "suspending");
            ac.abort();
            return jsonRes({ result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: "c2" });
        });

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ac.signal });

        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("suspended");        // resumable, not "aborted"
        expect(j.finishedAt).toBeUndefined();      // not terminal
        expect(j.progress[0].cookie).toBe("c2");   // cursor persisted for resume
    });

    it("finalizes to 'aborted' on a plain abort (no external suspend)", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const ac = new AbortController();
        const fetchFn = vi.fn(async () => {
            ac.abort();
            return jsonRes({ result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: "c2" });
        });

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ac.signal });

        expect(reg.getJob(job.id)!.status).toBe("aborted");
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/logs/log-pull-runner.test.ts`
Expected: the "suspended" test FAILS (current code sets `"aborted"` unconditionally on abort); the "aborted" test passes.

- [ ] **Step 3: Implement** — in `src/lib/logs/log-pull-runner.ts`, add a finalize helper and use it in BOTH abort paths.

Immediately after the line `const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret };`, add:

```typescript
    // On abort, distinguish a user-initiated suspend (status pre-flipped to
    // "suspending" by the suspend endpoint) from a true abort. Suspended is the
    // stable, resumable state; the per-source cookies are already persisted.
    const finalizeAborted = () => {
        const current = registry.getJob(job.id);
        registry.setJobStatus(job.id, current?.status === "suspending" ? "suspended" : "aborted");
    };
```

Replace the early abort block:
```typescript
    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "running");
```
with:
```typescript
    if (signal.aborted) {
        finalizeAborted();
        return;
    }
    registry.setJobStatus(job.id, "running");
```

Replace the final abort block:
```typescript
    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "completed");
```
with:
```typescript
    if (signal.aborted) {
        finalizeAborted();
        return;
    }
    registry.setJobStatus(job.id, "completed");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/logs/log-pull-runner.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Gates**

```bash
npx vitest run src/lib/logs/
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: all logs tests pass; "no logs type errors"; eslint clean.

- [ ] **Step 6: Commit** (stage ONLY these two files)

```bash
git add src/lib/logs/log-pull-runner.ts src/lib/logs/log-pull-runner.test.ts
git commit -m "feat(logs): runLogPull finalizes external suspend to resumable 'suspended'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Controllers registry + start / jobs / manifest routes

**Files:**
- Create: `src/app/api/logs/archive/route-controllers.ts`
- Create: `src/app/api/logs/archive/pull/route.ts`
- Create: `src/app/api/logs/archive/jobs/route.ts`
- Create: `src/app/api/logs/archive/manifest/route.ts`

- [ ] **Step 1: Create the AbortController registry** — `src/app/api/logs/archive/route-controllers.ts`:

```typescript
// Shared AbortController registry for in-flight log-pull jobs. Its own module so
// the start-pull, suspend, and resume routes can register/look up controllers
// without a circular import.
const controllers = new Map<string, AbortController>();

export function getController(id: string): AbortController | undefined {
    return controllers.get(id);
}
export function setController(id: string, ctl: AbortController): void {
    controllers.set(id, ctl);
}
export function deleteController(id: string): void {
    controllers.delete(id);
}
```

- [ ] **Step 2: Create the start-pull route** — `src/app/api/logs/archive/pull/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { getLogRegistry, LogJobConflictError } from "@/lib/logs/log-job-registry";
import { runLogPull } from "@/lib/logs/log-pull-runner";
import { setController, deleteController } from "../route-controllers";

export const dynamic = "force-dynamic";

/** The log sources the archive supports (AM + IDM). */
export const DEFAULT_LOG_SOURCES = [
    "am-authentication", "am-access", "am-core",
    "idm-access", "idm-activity", "idm-authentication",
];
const ALLOWED = new Set(DEFAULT_LOG_SOURCES);

/**
 * Body: { env, from, to, sources? }. `from`/`to` are ISO timestamps. When
 * `sources` is omitted, all supported sources are pulled. Starts a background
 * pull and returns 202 with the job id; the client polls GET /jobs for progress.
 */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const env = typeof body.env === "string" ? body.env : "";
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";
    let sources: string[] = Array.isArray(body.sources)
        ? body.sources.filter((s: unknown): s is string => typeof s === "string")
        : [];
    if (sources.length === 0) sources = [...DEFAULT_LOG_SOURCES];

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required" }, { status: 400 });
    }
    const invalid = sources.filter((s) => !ALLOWED.has(s));
    if (invalid.length) {
        return NextResponse.json({ error: `unsupported sources: ${invalid.join(", ")}` }, { status: 400 });
    }

    const creds = getLogApiCredentials(env);
    if (!creds) {
        return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
    }
    const vars = parseEnvFile(getEnvFileContent(env));
    const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
    if (!tenantBaseUrl) {
        return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
    }

    const registry = getLogRegistry();
    let job;
    try {
        job = registry.startJob(env, sources, from, to);
    } catch (e) {
        // instanceof can fail when the singleton survives a module reload; also
        // match by name.
        if (e instanceof LogJobConflictError || (e as Error).name === "LogJobConflictError") {
            const existingId = (e as LogJobConflictError).existingJobId;
            const existing = registry.getJob(existingId);
            return NextResponse.json({ jobId: existingId, status: existing?.status ?? "running" }, { status: 409 });
        }
        throw e;
    }

    const ctl = new AbortController();
    setController(job.id, ctl);
    void runLogPull({
        job,
        registry,
        archiveRoot: logDataDir(env),
        tenantBaseUrl,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        signal: ctl.signal,
    }).finally(() => deleteController(job.id));

    return NextResponse.json({ jobId: job.id, sources }, { status: 202 });
}
```

- [ ] **Step 3: Create the jobs-list route** — `src/app/api/logs/archive/jobs/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogRegistry } from "@/lib/logs/log-job-registry";

export const dynamic = "force-dynamic";

/** GET /api/logs/archive/jobs?env=prod&includeFinished=1 */
export async function GET(req: NextRequest) {
    const env = req.nextUrl.searchParams.get("env") ?? undefined;
    const includeFinished = req.nextUrl.searchParams.get("includeFinished") === "1";
    const jobs = getLogRegistry().listJobs({ env, includeFinished });
    return NextResponse.json({ jobs });
}
```

- [ ] **Step 4: Create the manifest route** — `src/app/api/logs/archive/manifest/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { readManifest } from "@/lib/logs/manifest";

export const dynamic = "force-dynamic";

/** GET /api/logs/archive/manifest?env=prod — covered-range coverage per source. */
export async function GET(req: NextRequest) {
    const env = req.nextUrl.searchParams.get("env");
    if (!env) return NextResponse.json({ error: "env is required" }, { status: 400 });
    return NextResponse.json({ manifest: readManifest(logDataDir(env)) });
}
```

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/api/logs/
```
Expected: `tsc` prints nothing (whole-project clean); eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/logs/archive/route-controllers.ts \
        src/app/api/logs/archive/pull/route.ts \
        src/app/api/logs/archive/jobs/route.ts \
        src/app/api/logs/archive/manifest/route.ts
git commit -m "feat(logs): archive pull/jobs/manifest API routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Suspend + resume routes

**Files:**
- Create: `src/app/api/logs/archive/jobs/[id]/suspend/route.ts`
- Create: `src/app/api/logs/archive/jobs/[id]/resume/route.ts`

- [ ] **Step 1: Create the suspend route** — `src/app/api/logs/archive/jobs/[id]/suspend/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogRegistry } from "@/lib/logs/log-job-registry";
import { getController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

/**
 * Suspend a running pull. Flip status to "suspending" BEFORE aborting so the
 * runner's abort path finalizes to the resumable "suspended" state (per-source
 * cookies are already persisted). Lifecycle: running → suspending → suspended.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const registry = getLogRegistry();
    const job = registry.getJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (job.status === "suspended" || job.status === "suspending") {
        return NextResponse.json({ jobId: id, status: job.status }, { status: 200 });
    }
    if (job.status !== "running" && job.status !== "queued") {
        return NextResponse.json({ error: `cannot suspend job in status '${job.status}'` }, { status: 409 });
    }

    registry.setJobStatus(id, "suspending");
    getController(id)?.abort();
    return NextResponse.json({ jobId: id, status: "suspending" }, { status: 202 });
}
```

- [ ] **Step 2: Create the resume route** — `src/app/api/logs/archive/jobs/[id]/resume/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { getLogRegistry } from "@/lib/logs/log-job-registry";
import { runLogPull } from "@/lib/logs/log-pull-runner";
import { setController, deleteController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

/** Resume an interrupted/suspended pull from its persisted per-source cookies. */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const registry = getLogRegistry();
    const job = registry.getJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (job.status !== "interrupted" && job.status !== "suspended") {
        return NextResponse.json({ error: `cannot resume job in status '${job.status}'` }, { status: 409 });
    }

    // Block resume if a DIFFERENT job is active for the env.
    const active = registry.getActiveJobForEnv(job.env);
    if (active && active.id !== job.id) {
        return NextResponse.json(
            { jobId: active.id, status: active.status, error: "another job is active for this env" },
            { status: 409 },
        );
    }

    const creds = getLogApiCredentials(job.env);
    if (!creds) {
        return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
    }
    const vars = parseEnvFile(getEnvFileContent(job.env));
    const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
    if (!tenantBaseUrl) {
        return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
    }

    const ctl = new AbortController();
    setController(job.id, ctl);
    void runLogPull({
        job,
        registry,
        archiveRoot: logDataDir(job.env),
        tenantBaseUrl,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        signal: ctl.signal,
    }).finally(() => deleteController(job.id));

    return NextResponse.json({ jobId: job.id }, { status: 202 });
}
```

- [ ] **Step 3: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/api/logs/
```
Expected: `tsc` clean; eslint clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/logs/archive/jobs/[id]/suspend/route.ts" \
        "src/app/api/logs/archive/jobs/[id]/resume/route.ts"
git commit -m "feat(logs): archive suspend + resume API routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase A2b

- `runLogPull` finalizes an externally-triggered suspend to the resumable `"suspended"` state (unit-tested).
- API routes exist: start (`POST /api/logs/archive/pull`), list (`GET /api/logs/archive/jobs`), coverage (`GET /api/logs/archive/manifest`), suspend + resume.
- `npx tsc --noEmit` and `npx eslint` are clean across `src/lib/logs/` and `src/app/api/logs/`; the full Vitest suite stays green.

## Manual smoke test (run once against a real env, e.g. `prod`)

The pull hits the live tenant and is rate-limited; use a SMALL window first.

```bash
# Start a 5-minute pull of one source
curl -s -X POST localhost:3000/api/logs/archive/pull \
  -H 'content-type: application/json' \
  -d '{"env":"prod","sources":["am-authentication"],"from":"2026-06-02T00:00:00Z","to":"2026-06-02T00:05:00Z"}'
# → {"jobId":"...","sources":["am-authentication"]}

# Poll progress
curl -s 'localhost:3000/api/logs/archive/jobs?env=prod&includeFinished=1' | jq '.jobs[0].progress'

# Coverage after it completes
curl -s 'localhost:3000/api/logs/archive/manifest?env=prod' | jq '.manifest.sources'

# Suspend / resume a longer-running pull
curl -s -X POST localhost:3000/api/logs/archive/jobs/<id>/suspend
curl -s -X POST localhost:3000/api/logs/archive/jobs/<id>/resume
```

**During this smoke test, verify the A2a integration caveat:** log the raw `x-ratelimit-reset` from a response and confirm it is **epoch seconds** (~1.7e9, year-2025+ range), not delta-seconds — `paceDelayMs` assumes epoch. Confirm files appear under `environments/prod/log-data/am-authentication/<day>.ndjson` and the day `.sqlite`.

## Self-review notes (author)

- **Spec coverage (A2b scope):** start/list/manifest/suspend/resume ✓; background + poll (not inline streaming) matches the long-running, resumable, rate-limited nature ✓; credentials via `getLogApiCredentials` + tenant URL via env file ✓; archiveRoot via `logDataDir` ✓; default-all-sources with allowlist ✓; suspend→suspended lifecycle wired end-to-end (Task 1 + suspend route) ✓.
- **Deferred (not this phase):** the pull UI panel (A2c) and the journey Live|Archive toggle (A3).
- **Placeholder scan:** none — full code in every step.
- **Type consistency:** routes call `getLogRegistry`/`LogJobConflictError`/`startJob(env,sources,from,to)`/`listJobs`/`getActiveJobForEnv`/`setJobStatus`, `runLogPull({job,registry,archiveRoot,tenantBaseUrl,apiKey,apiSecret,signal})`, `logDataDir`, `readManifest` — all matching A1/A2a signatures.
- **Testing deviation:** route handlers are verified by tsc/eslint + curl smoke (consistent with the untested data-pull routes), not Vitest; the engine they drive is unit-tested in A2a, and the one piece of new logic (runner suspend finalization) is unit-tested in Task 1.
