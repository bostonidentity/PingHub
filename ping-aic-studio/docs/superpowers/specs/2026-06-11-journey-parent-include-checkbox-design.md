# Parent-journey include checkbox in the inner-journey picker

**Date:** 2026-06-11
**Status:** Approved

## Problem

Selecting a master journey in the Journey History report always pulls its events.
When the user only cares about one inner journey, the master selection is just the
discovery mechanism — it exposes the dep tree so the inner journey can be found and
checked — yet its events dominate the pull cost (e.g. `kyid_2B1_MasterLogin` is
~100k events / ~100 pages on uat, vs a handful of pages for a single inner journey).

There is no way to say "use this journey for structure/picking, but don't pull it."

## Behavior

Each "Inner journeys of \<parent\>" section in `JourneyDepPicker` gains a **parent
row** at the top: a checkbox for the parent journey itself, **default checked**
(current behavior unchanged).

- **Checked** (default): parent's events are pulled, exactly as today.
- **Unchecked**: the parent's own events are excluded from the pull. The run
  fetches only the checked inner journeys. The parent stays selected in the
  journey selector, so its dep tree remains visible for picking.

With the parent excluded, the report shows the chosen inner journey(s) standalone:
their own rates, attempts, and node structure. There is no nesting under the
parent's evaluator rows — those events were not pulled. This is the accepted
trade-off; the fast pull is the point.

### UI

The parent renders as a depth-0 checkbox row above its children:

```
Inner journeys of kyid_2B1_MasterLogin   [Select all] [Expand all]
  ☑ kyid_2B1_MasterLogin (include this journey's own events)
  ☐ kyid_2B1_KerberosMain
      ▸ ☐ kyid_2B1_Krb_Fallback
  ☑ kyid_2B1_DeviceCheck
```

The section footer text gains a sentence noting that an unchecked parent is used
for structure/picking only.

"Select all" / "Clear" continue to operate on inner journeys only; they do not
touch the parent row.

## Design

No backend changes. The feature is entirely a change to which `treeNames` the
panel sends; the runner, filter builder, and report format are untouched.

### State and wiring

- New panel state in `JourneyHistoryPanel`: `excludedParents: string[]` — names of
  selected parents whose own events are excluded. **Ephemeral** (not persisted in
  `SavedSettings`), matching `innerChecked`, so both halves of the picker behave
  consistently across app restarts.
- `JourneyDepPicker` gains props `excludedParents: string[]` and
  `onExcludedChange(next: string[])`. The parent row toggles membership.
- A pruning effect drops entries from `excludedParents` whose parent journey was
  deselected, mirroring the existing inner-check pruning (an exclusion must never
  outlive its parent's selection).

### Pull-list computation

The `runTreeNames` memo (`JourneyHistoryPanel.tsx` ~line 260) moves into a pure
helper next to `journey-filter.ts`:

```ts
/** Journeys a run pulls: selected parents minus excluded ones, plus checked inner journeys.
 *  No parents selected → [] (no filter); inner picks only ride along with parents. */
export function runTreeNames(selected: string[], excludedParents: string[], innerChecked: string[]): string[]
```

Semantics:

- `selected` empty → `[]` (no filter at all — unchanged).
- Otherwise → `unique((selected − excludedParents) ∪ innerChecked)`.

### Empty-pull guard

Empty `treeNames` with parents selected would fall through to an **unfiltered
pull of every journey** — the opposite of what the user asked for. `startRun`
gets a pre-flight check alongside the existing `singleWindowTooWide` check:

> parents are selected AND `runTreeNames(...)` is empty → block the run with
> the error "Nothing selected to pull — check the journey or at least one inner
> journey."

This can only occur when every selected parent is excluded and no inner journey
is checked; the picker's existing pruning prevents orphaned inner picks.

### Report semantics

Unchanged. The report's `selectedJourneys` metadata (and the history table's
"Journeys" column) reflect what was actually pulled — the inner journeys only,
when the parent is excluded.

## Testing

- Unit tests for `runTreeNames`: no parents; parents only; parents + inner;
  parent excluded + inner; all parents excluded + no inner (empty result);
  dedup of a name that is both selected and inner-checked.
- Unit test for the guard condition (selected non-empty, result empty → blocked).
- No component-test infrastructure exists for the analyze panels; the picker
  rendering and toggle behavior are verified manually, as with the prior
  inner-journey picker work.

## Out of scope

- Persisting `excludedParents` across restarts.
- Nesting an inner journey's report under a not-pulled parent's structure
  (would require pulling parent evaluator events; defeats the purpose).
- Any change to the report runner, query filter, or report format.
