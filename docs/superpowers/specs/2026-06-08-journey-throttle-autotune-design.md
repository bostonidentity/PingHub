# Journey report: self-tuning throttle response

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

During journey report generation, when AIC returns HTTP 429s the UI shows:

> Rate limited by AIC N× — auto-retrying with backoff … Pacing auto-raised; lower
> "Parallel windows" if it persists.

Two issues:

1. **The banner never clears.** Its visibility is driven by `job.progress.throttles`
   (`JourneyHistoryPanel.tsx:658`), a cumulative counter that only ever increments
   (`journey-report-runner.ts` `onThrottle`). A single 429 pins the banner up for the
   rest of the run, even long after throttling has subsided.
2. **The remediation is manual.** The banner tells the user to lower "Parallel
   windows" themselves. Pacing already auto-raises, but concurrency is fixed for the
   whole run and nothing reduces it automatically.

## Goals

- The banner shows only while the run is *actively* being throttled, and disappears
  once requests flow cleanly again.
- The run automatically lowers parallel windows under sustained throttling and
  recovers afterward, and auto-extends the per-page retry budget so a transient
  throttle is less likely to give up and pause the run.
- The manual "lower Parallel windows" advice text is removed (now automatic).

## Non-goals

- No UI for surfacing the auto-tuned values (user chose "hide when not actively
  throttling", not a summary line).
- Volume-quota 429s remain terminal — unchanged. This only governs *throughput* 429s.

## Design

### 1. `ThrottleGovernor` — new pure unit (`src/lib/reports/journey-throttle-governor.ts`)

A small, dependency-free state machine: the single place that decides how a run
reacts to throughput 429s. No registry / fs / network access, so it is unit-testable
in isolation.

State it owns:

- **Pacing floor** (moves existing `pacing.floor` logic here): `+AUTO_BUMP_MS` per
  429, capped at `MAX_BUMP_MS`; decays on recovery.
- **Concurrency target**: starts at the user's "Parallel windows" setting
  (`baseConcurrency`). **Lowers by 1 on every throttled page** (floor = 1).
  **Recovers +1 after a clean streak**, never above `baseConcurrency`. Asymmetric:
  fast down, slow up — avoids oscillation.
- **Retry budget**: `maxRetries` handed to `fetchLogPage` grows from the base (6)
  toward a cap (~12) as consecutive throttled pages accumulate; resets to base on a
  clean page.
- **Active flag**: set `true` on any 429; cleared after `CLEAN_TO_CLEAR` consecutive
  clean pages. Drives banner visibility.

Driving calls:

- `onThrottle(waitMs, attempt)` — wired into `fetchLogPage`'s existing `onThrottle`
  callback. Increments cumulative `throttles`, records `lastWaitMs`/`lastAttempt`,
  bumps the floor, sets active, resets the clean streak.
- `onPage(throttled: boolean)` — called once per completed page.
  - `throttled` → lower concurrency target by 1, grow retry budget, reset clean streak.
  - clean → increment clean streak; clear active flag at `CLEAN_TO_CLEAR`; step
    concurrency back up and decay the floor at `CLEAN_TO_RECOVER`; reset retry budget.

Read accessors: `floorMs()`, `targetConcurrency()`, `maxRetries()`, `isThrottling()`,
plus `throttles`, `lastWaitMs`, `lastAttempt` for progress.

Constants (initial values, tunable): `CLEAN_TO_CLEAR = 3`, `CLEAN_TO_RECOVER = 8`,
`MIN_CONCURRENCY = 1`, retry cap = base + 6. Reuses `AUTO_BUMP_MS`/`MAX_BUMP_MS` from
`log-fetch`.

### 2. Runner wiring (`journey-report-runner.ts`)

- Construct one governor per run: `new ThrottleGovernor({ baseConcurrency: concurrency,
  baseMaxRetries: 6 })`. It seeds `throttles` from `p.throttles` on resume.
- Replace the inline `pacing` object and `onThrottle` closure with the governor.
  `onThrottle` now also writes `throttling: true` into progress.
- `pageWindow`:
  - capture `const tBefore = governor.throttles` before each `fetchLogPage`.
  - pass `maxRetries: governor.maxRetries()` to `fetchLogPage`.
  - pace with `governor.floorMs()` instead of `pacing.floor`.
  - after a successful page: `governor.onPage(governor.throttles > tBefore)` then push
    `{ throttling: governor.isThrottling() }` into progress.
- **Chunked worker pool** (currently `Promise.all` of a fixed worker count at
  `journey-report-runner.ts:430`): replace with a small resizable supervisor that keeps
  the number of active workers at `governor.targetConcurrency()`.
  - Workers are long-lived loops; each self-sheds (returns) when `active >
    targetConcurrency()`, checked *before* claiming the next slot (no lost slot).
  - A supervisor respawns workers up to target as workers complete/exit, and resolves
    when `active === 0` and there is no pending work (or a terminal flag is set).
  - Starts at and never exceeds `baseConcurrency`, so the existing
    "limits in-flight windows to windowConcurrency" test still holds.
  - Grow-back is one-window-granular (a raised target takes effect as the next worker
    completes its current window) — deliberately simple, no reentrant callbacks.

### 3. Progress + banner

- Add `throttling?: boolean` to `JourneyReportProgress` (`journey-report-types.ts`).
- Banner condition in `JourneyHistoryPanel.tsx` changes from `job.progress.throttles`
  to `job.progress.throttling`. The cumulative count / last-attempt detail stays in the
  banner text *while active*; the "Pacing auto-raised; lower 'Parallel windows' if it
  persists." sentence is removed.

## Error handling / edge cases

- Single-window runs: `baseConcurrency = 1`, so the target never moves; the governor
  still drives the floor, retry budget, and the banner active flag. Unchanged paging.
- Volume-quota 429s short-circuit terminal inside `fetchLogPage` (unchanged) and never
  reach `onThrottle`, so they don't move the governor.
- Resume: `throttles` seeds from persisted progress; concurrency/floor/retry reset to
  base on a fresh `runJourneyReport` invocation (a resumed run starts un-throttled,
  which is correct — the throttle state was transient).
- Abort/suspend/fail outcomes from `pageWindow` are unchanged; the pool propagates them
  via the existing terminal flags.

## Testing

**Governor unit tests** (`journey-throttle-governor.test.ts`):

- lowers concurrency by 1 per throttled page, floored at 1.
- recovers +1 only after `CLEAN_TO_RECOVER` clean pages, capped at `baseConcurrency`.
- floor rises per 429 (capped) and decays on recovery.
- `maxRetries` grows under sustained throttling and resets on a clean page.
- `isThrottling()` set on throttle, cleared after `CLEAN_TO_CLEAR` clean pages.

**Runner tests** (extend `journey-report-runner.test.ts`):

- `throttling` becomes `true` on a 429 and clears to `false` after subsequent clean
  pages within the same run.
- under sustained 429s on a chunked run, max in-flight windows drops below the
  configured setting; with throttling only at the start, it recovers toward the setting.
- existing tests stay green (concurrency cap, suspend-on-sustained-429, throttle count,
  volume-quota terminal).
