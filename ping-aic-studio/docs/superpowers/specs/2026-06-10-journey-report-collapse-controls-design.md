# Journey Report: Expand/Collapse Controls for Inner-Journey Displays

**Date:** 2026-06-10
**Status:** Approved design, pre-implementation
**Builds on:** `2026-06-10-journey-inner-tree-trace-nesting-design.md` (the picker and
the nested results tree this feature adds controls to).

## Problem

Two inner-journey displays lack adequate collapse controls:

1. **Inner-journey picker** (`JourneyDepPicker`, report form): each "Inner
   journeys of X" section renders its whole dependency tree fully expanded,
   always. Deep closures clutter the form.
2. **Node outcomes tree** (`NodeOutcomeTree`, report results): rows collapse
   correctly (collapsed by default), but Expand all / Collapse all exists only
   globally — there is no way to expand or collapse one journey's subtree at
   once.

## Decisions (settled with user)

1. **Both surfaces** get the treatment.
2. **Picker default state:** first level visible — each section shows its
   direct inner journeys; branches with their own children get a caret and
   start collapsed.
3. **Results tree:** per-journey Expand all / Collapse all on every tree row
   (roots *and* inner journeys), subtree-scoped; the global header buttons stay.

## Design

### `JourneyDepPicker.tsx` (self-contained change)

- New local state `openBranches: Set<string>`, keyed by row **path**
  (`parent>child>…` — the string already used as the React key). Absent key =
  collapsed. Path-keying means a reused inner journey under two branches
  collapses independently (consistent with `NodeOutcomeTree`'s pathKey scheme).
- `DepRow` gains `path: string`, `open: Set<string>`, `onToggleBranch(path)`
  props. Rows whose node has children render a `▸/▾` caret **button** before
  the checkbox; rows without children render a fixed-width spacer so checkboxes
  stay aligned. Children render only when `open.has(path)`.
- A collapsed branch whose hidden descendants include checked names shows a
  subtle `· n selected` count on the branch row (n = count of distinct checked
  descendant names, excluding the branch row's own checkbox), so hidden
  selections are never invisible.
- Each section header gains "Expand all / Collapse all" next to the existing
  "Select all / Clear": Expand all adds every branch path under that parent
  (computed by walking the parent's tree); Collapse all removes them.
- Checkbox semantics unchanged: Select all still selects the entire closure
  regardless of collapse state; toggling a checkbox never changes collapse
  state.
- State is ephemeral (component state, resets with env/remount), like the
  checklist itself. Not persisted.

### `NodeOutcomeTree.tsx`

- Extract the subtree key-walk currently inlined in `setAll` into a helper
  `collectKeys(tree, treeKey, seen)` that returns the set of tree-row keys AND
  node-breakdown keys under one subtree (cycle-guarded via the existing
  seen-set pattern).
- `setAll(expand)` (global) reuses the helper across all roots — behavior
  unchanged.
- New `setAllUnder(tree, treeKey, expand)`: computes the subtree's keys (always
  including `treeKey` itself) and merges them into `open` (expand) or deletes
  them from `open` (collapse).
- Every tree row (root and inner) renders two right-aligned tiny text actions —
  "expand all" and "collapse all" — calling `setAllUnder` with
  `e.stopPropagation()` so the row's own toggle doesn't fire. Cyclic rows
  (`↻ shown above`) get no actions, matching their disabled toggle.
- Expanding a subtree expands its node outcome breakdowns too — consistent
  with the global Expand all.
- Default expansion (roots open, everything else collapsed) is already correct
  and untouched. The active-filter state (`q` forces rows open) needs no
  special handling: the buttons mutate `open`, which takes effect as usual and
  fully applies once the filter clears.

## Error handling

Nothing new — pure view state. Cycles are already guarded in both components
(`repeated` nodes have no children in the picker; `ancestors`/seen-set in the
results tree).

## Testing

No component test framework exists in this repo. Verification: `npx tsc
--noEmit`, `npx eslint` on both files, full `npm test` (unchanged), and a
manual check in the running app (picker: caret collapse, per-section
expand/collapse all, selected-count badge; results: per-row subtree
expand/collapse incl. breakdowns, global buttons unchanged).

## Out of scope

- Persisting collapse state.
- Any change to selection semantics, fetching, or the analyzer.
- Virtualization / performance work for very large trees.
