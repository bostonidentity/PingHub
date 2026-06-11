# Journey History run-setting defaults, persistence, and reset

**Date:** 2026-06-11
**Status:** Approved

## Problem

The Journey History form's defaults predate the tuning work: Rates only checked,
Retain raw off, Window split 24h, Parallel windows 4, Request delay 5s. Measured
against real uat pulls these are the slow settings (a 1h split with 6 parallel
windows and a 2s delay is ~3x faster on bursty days and avoids per-window
truncation). Also, "Rates only" is deliberately not remembered across restarts,
which now just means re-unchecking it every session; and once settings drift
there is no way back to a known-good baseline short of editing each field.

## Behavior

1. **New defaults**, applied when nothing is saved and restored by Reset:

   | Setting | Default |
   |---|---|
   | Rates only (`summaryOnly`) | unchecked (false) |
   | Retain raw (`retainRaw`) | checked (true) |
   | Window split (`windowHours`) | 1 |
   | Parallel windows (`windowConcurrency`) | 6 |
   | Request delay (`requestDelaySec`) | 2 |
   | Max events (`maxEvents`) | 20000 (unchanged) |

2. **Every run setting persists across app restarts.** Five of the six already
   do (localStorage `SavedSettings`); `summaryOnly` joins them. The old guard
   (reset Rates only to checked every load so the Inspect drill-down's
   temporary rates-off can't become sticky) is removed: with the default now
   unchecked, stickiness is no longer a hazard, and "remember what the user
   set" becomes the uniform rule. Inspect's other prefill (`windowHours` 0)
   already persisted before this change — no new behavior.

3. **"Reset settings" button** on the settings row sets the six run settings
   back to the defaults above. It does NOT touch environment, date range,
   journey selection, inner-journey picks, parent exclusions, scope, or data
   source. No confirmation dialog — nothing destructive is lost. The
   persistence effect saves the reset values automatically (no special
   handling).

## Design

All changes live in `src/app/analyze/JourneyHistoryPanel.tsx`.

- A module-level constant is the single source of truth:

  ```ts
  const RUN_SETTING_DEFAULTS = {
      summaryOnly: false,
      retainRaw: true,
      windowHours: 1,
      windowConcurrency: 6,
      requestDelaySec: 2,
      maxEvents: 20000,
  } as const;
  ```

- The six `useState` initializers read `saved?.x ?? RUN_SETTING_DEFAULTS.x`
  (for `summaryOnly`, this replaces the bare `useState(true)`).
- `SavedSettings` gains `summaryOnly?: boolean`; the localStorage save effect
  adds `summaryOnly` to its payload and dependency list.
- `resetRunSettings()` calls the six setters with the constant's values; the
  button renders alongside the existing settings inputs.

### Migration

Persisted values win over defaults — that is the point of persistence. A
browser with existing `SavedSettings` keeps its stored values after this
change; clicking Reset once adopts the new defaults. No version stamp or
forced migration: silently overriding a user's remembered settings would
contradict requirement 2.

## Testing

- No new unit tests: the change is a constant plus six setState calls, with no
  extractable logic; there is no component-test infrastructure for the analyze
  panels.
- Existing suite must stay green (`npm test`), plus `tsc --noEmit` and eslint.
- Manual smoke: fresh profile (or cleared localStorage) shows the new
  defaults; change a setting, restart the app, the change survives —
  including Rates only; click Reset settings → the six values revert, other
  form state untouched; restart again → reset values survived.

## Out of scope

- Resetting environment, date range, journey/inner-journey selection, scope,
  or data source.
- Server-side or per-env settings storage.
- Changing `HARD_MAX_EVENTS` or any backend default (`DEFAULT_WINDOW_CONCURRENCY`,
  `DEFAULT_REQUEST_DELAY_MS` in the runner stay as they are — they only apply
  when a job omits the params, which the panel never does).
