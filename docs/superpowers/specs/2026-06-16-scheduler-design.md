# Scheduler Feature — Design Spec

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Branch:** `feature/scheduler`

## 1. Summary

Add a **scheduler** to PingHub that fires existing PingHub operations on a time
trigger and records the results. Three task types are schedulable, individually
or chained into a pipeline:

1. **Sync** — config pull on selected environment + scopes (today's `/api/pull`).
2. **Pull data** — managed-data pull on selected environment + managed objects
   (today's `/api/data/pull` + job registry).
3. **Git push** — commit and push to the environment's git repo (today's
   `/api/push` + `git.ts`).

The scheduler runs **in-process**: it starts with the Next.js server and fires
jobs while the app is running. It does **not** run when the app is closed; missed
runs are handled by an opt-in catch-up on next startup.

## 2. Goals / Non-Goals

### Goals
- Define schedules with simple presets (hourly / daily-at-time / weekly-on-days)
  **and** an advanced cron expression.
- A schedule runs either a single task or an ordered pipeline of steps.
- Scheduled runs appear in the **existing** History UI alongside manual runs.
- Survive app restarts: schedule definitions are persisted; missed runs can
  optionally catch up once on startup.
- CRUD + run-now via API and a dedicated Schedules UI section.

### Non-Goals
- Truly unattended execution when the app is closed (no OS cron / always-on
  service). Explicitly rejected during brainstorming.
- Distributed / multi-instance scheduling. The app is assumed to run as a single
  local instance.
- New notification channels (email/Slack). Failures surface in-app only.

## 3. Background — current architecture

PingHub is a **Next.js 16 (App Router, TypeScript)** app under `ping-aic-studio/`.
There is **no existing job queue, cron, or background worker**. The three target
operations currently live inside HTTP route handlers that stream JSONL logs back
to the browser:

| Operation | Route | Core logic location |
|-----------|-------|---------------------|
| Sync (config pull) | `src/app/api/pull/route.ts` | inline in POST handler |
| Pull data | `src/app/api/data/pull/route.ts` | `src/lib/data/job-registry.ts` |
| Git push | `src/app/api/push/route.ts` | `src/lib/git.ts` |

Persistence patterns already in use:
- `environments.json` — environment definitions (JSON file in `ENVIRONMENTS_DIR`).
- `environments/.op-log.jsonl` — operation history (JSONL, rotated at 500).
- `src/lib/op-history.ts` — append/read op-log, merge with git commit history.
- `environments/<env>/managed-data/.jobs/<jobId>.json` — resumable data-pull jobs.

`ENVIRONMENTS_DIR` is resolved in `src/lib/paths.ts`.

## 4. Core architectural decision: extract operation cores

The single most important change. Today's operation logic is tied to the HTTP
request/streaming lifecycle and cannot be called without a browser. We extract
the core of each operation into a reusable lib function that returns a result and
writes an op-log entry, with **no dependency on a `Request`/`Response`**:

```
src/lib/operations/
  run-sync.ts       export async function runSync(opts): Promise<OpResult>
  run-data-pull.ts  export async function runDataPull(opts): Promise<OpResult>
  run-git-push.ts   export async function runGitPush(opts): Promise<OpResult>
  types.ts          OpResult, OpLogSink, etc.
```

- The **existing API routes** are refactored to call these cores and adapt the
  emitted log events into their current JSONL stream (no change to the
  browser-facing contract).
- The **scheduler** calls the same cores directly, passing a log sink that writes
  to the op-log instead of an HTTP stream.

`OpResult` shape (approx):
```ts
interface OpResult {
  status: 'success' | 'failed' | 'partial';
  runId: string;
  summary: string;
  durationMs: number;
  error?: string;
}
```

A shared `OpLogSink` interface lets the same core emit progress to either an HTTP
stream (manual run) or the op-log + in-memory buffer (scheduled run).

## 5. Data model

Schedules persist to `ENVIRONMENTS_DIR/schedules.json` (mirrors `environments.json`).

```ts
type StepType = 'sync' | 'pull-data' | 'git-push';

interface SyncStep      { type: 'sync';      environment: string; scopes: ConfigScope[]; }
interface PullDataStep  { type: 'pull-data'; environment: string; managedObjects: string[]; }
interface GitPushStep   { type: 'git-push';  environment: string; message?: string; }
type Step = SyncStep | PullDataStep | GitPushStep;

interface Trigger {
  kind: 'preset' | 'cron';
  preset?:
    | { every: 'hour'; minute: number }
    | { every: 'day';  time: string /* HH:mm */ }
    | { every: 'week'; days: number[] /* 0-6 */; time: string };
  cron?: string;                 // when kind === 'cron'
  timezone: string;              // IANA tz, defaults to system tz
}

interface ScheduleRunRef {
  at: string;                    // ISO timestamp
  status: 'success' | 'failed' | 'partial' | 'skipped-overlap';
  runId: string;                 // links to op-log entry
}

interface Schedule {
  id: string;                    // uuid
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];                 // length 1 = single task; >1 = pipeline
  onError: 'stop' | 'continue';  // pipeline failure behavior
  catchUpIfMissed: boolean;      // run once on startup if nextRunAt is in the past
  lastRun?: ScheduleRunRef;
  nextRunAt: string;             // ISO; recomputed after each fire and on edit
  createdAt: string;
  updatedAt: string;
}
```

Presets compile to a cron string internally, so there is **one** timing engine
(`cron-parser` computes `nextRunAt` from the resolved cron + timezone).

## 6. Scheduler engine (tick-based)

A singleton scheduler starts via Next.js `instrumentation.ts` `register()`
(guarded to the `nodejs` runtime and to a single initialization).

```
src/lib/scheduler/
  engine.ts        start(), stop(), tick(), runSchedule(id)
  store.ts         read/write schedules.json (atomic write)
  cron.ts          presetToCron(), computeNextRun(cron, tz, from)
  registry.ts      in-memory run locks + last-tick state
```

**Tick loop** (every 60s):
1. Read `schedules.json`.
2. For each `enabled` schedule whose `nextRunAt <= now` and that is **not**
   currently running, fire it.
3. After firing (or skipping), recompute and persist `nextRunAt`.

**Startup catch-up:** on `start()`, any enabled schedule whose `nextRunAt` is
already in the past runs **once** if `catchUpIfMissed` is true; otherwise its
`nextRunAt` is rolled forward without running. Missed runs are **never**
bulk-replayed.

**Overlap:** an in-memory per-schedule lock. If a run is still in progress when
the next fire is due, the new fire is skipped and recorded as
`skipped-overlap` in the op-log and `lastRun`.

**Running a schedule:** execute `steps` in order. On a step failure, `onError`
decides stop-vs-continue. Each step calls its operation core
(`runSync` / `runDataPull` / `runGitPush`). The whole run writes a single
op-log entry tagged `trigger: 'scheduled'`, `scheduleId`, and per-step status.

## 7. Run history

Reuse the existing op-log (`op-history.ts`). Scheduled runs append an op-log
entry with added fields `{ trigger: 'scheduled', scheduleId }`. This makes
scheduled runs show up in the **existing History UI** with no new history
surface. `op-history.ts` is extended with the two optional fields and a filter
to view scheduled-only runs.

## 8. API

Following existing `route.ts` conventions:

| Route | Methods | Purpose |
|-------|---------|---------|
| `src/app/api/schedules/route.ts` | `GET`, `POST` | list all / create |
| `src/app/api/schedules/[id]/route.ts` | `GET`, `PUT`, `DELETE` | read / update / delete |
| `src/app/api/schedules/[id]/run/route.ts` | `POST` | run now (manual trigger) |

CRUD endpoints read/write `schedules.json` via `store.ts`. On any create/update,
`nextRunAt` is recomputed. `run` invokes `engine.runSchedule(id)` immediately,
respecting the overlap lock.

## 9. UI

A new **Schedules** nav section.

- **List view:** one row per schedule — name, enabled toggle, trigger summary
  ("Daily 02:00"), last run (status badge), next run (relative time), and
  run-now / edit / delete actions.
- **Create/Edit modal:**
  - Name, enabled.
  - **Trigger picker:** preset tabs (Hourly / Daily / Weekly) + an "Advanced"
    cron field; live "next 3 runs" preview.
  - **Step builder:** add/reorder/remove steps; each step picks its type and
    reuses the **existing** environment / scope / managed-object pickers from the
    sync and data-pull forms.
  - `onError` (stop/continue) and `catchUpIfMissed` toggles.
- Status badges and the run history link reuse existing History UI components.

## 10. Error handling

- Step failures are captured per-step in the op-log entry; the run status is
  `failed` (any step failed with `onError: 'stop'`) or `partial`
  (`onError: 'continue'` with some failures).
- The Schedules list shows a failure badge on the last run; clicking opens the
  op-log entry in History.
- Engine-level errors (bad cron, unreadable `schedules.json`) are logged and the
  affected schedule is marked disabled-with-error rather than crashing the tick.

## 11. Testing

- **Unit:** `cron.ts` (preset→cron, next-run computation across DST/timezones),
  `store.ts` (atomic read/write, schema validation), overlap-lock logic.
- **Unit:** operation cores (`runSync`/`runDataPull`/`runGitPush`) with the git
  and subprocess boundaries mocked, asserting `OpResult` + op-log writes.
- **Integration:** engine `tick()` with a fake clock — due/not-due selection,
  catch-up on startup, overlap skip, pipeline `onError` behavior.
- **Regression:** existing pull/push/data-pull API routes still produce the same
  browser-facing JSONL stream after the core extraction.

## 12. Build sequence

1. Extract operation cores + refactor existing routes to use them (no behavior
   change; verified by regression tests).
2. Schedule store + cron utilities (`store.ts`, `cron.ts`) with unit tests.
3. Scheduler engine (`engine.ts`, `registry.ts`) + `instrumentation.ts` wiring,
   with fake-clock integration tests.
4. API routes (CRUD + run-now).
5. UI (list + create/edit modal), reusing existing pickers and History components.
6. End-to-end pass and docs.

## 13. Open defaults (baked in unless changed)

- Missed runs execute **once** on next startup when `catchUpIfMissed` is on;
  never bulk-replayed.
- The git-push step pushes to the **already-configured remote** for the
  environment's repo.
- Tick granularity is **60s** (sub-minute schedules are not supported).
