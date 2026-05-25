# Script Viewer Selection & Highlight Performance

**Status:** Design — pending implementation plan
**Date:** 2026-04-28

## Problem

Selecting and clicking inside a script in the Browse (`/configs`) tab feels laggy. Two compounding causes in `aic-pipeline/src/components/FileContentViewer.tsx` and `aic-pipeline/src/components/ScriptFileViewer.tsx`:

1. **Mousedown inflates virtualizer overscan from 24 to 500 rows.** `FileContentViewer.tsx:302-330` flips a `selecting` state on every mousedown inside the viewer, which causes `useVirtualizer`'s `overscan` to jump from `24` to `Math.min(visibleLines.length, 500)`. The intent is to keep already-selected rows mounted so the browser's native `Selection` doesn't collapse mid-drag, but the side effect is a render burst at the start of *every* mousedown — including a simple click. For a 1000+ line script with rich syntax tokens, mounting ~480 extra `<Row>` components in one frame is visible lag.

2. **Inline callback props defeat `Row.memo`.** `Row` is `memo`'d, but `ScriptFileViewer.tsx` passes `onLineClick={(ln) => setCurrentLine(ln)}` and `onToggleFold={(ln) => ...}` as fresh inline arrow functions on every render (`ScriptFileViewer.tsx:1136-1137`). Each render produces new function references, so `memo`'s shallow prop comparison fails and every visible `Row` re-renders on any state change. Combined with #1, a single click can re-render 500+ rows.

## Goal

Make selection (click, drag-select within the viewport) and line-highlighting state changes (active line, find match) feel instant, without changing user-visible behavior beyond performance.

## Non-goals

- No change to syntax tokenization, format-on/off, comment-strip logic.
- No change to the left-side list virtualization in `ConfigsViewer.tsx` (separate concern).
- No new lazy/per-line tokenization.
- No removal of virtualization during selection.
- No new dependency.

## Approach

Two surgical changes in two files:

### Change A — Stabilize callback props with `useCallback`

In `aic-pipeline/src/components/ScriptFileViewer.tsx`, wrap the callbacks passed into `<FileContentViewer>` in `useCallback`. Specifically:

- The `onLineClick` arrow currently inlined at the JSX call site becomes a `useCallback(... [setCurrentLine])` defined alongside the other state hooks.
- The `onToggleFold` callback (currently inline) becomes a `useCallback`. Its dependency is `setFoldedStartLines` (a stable setter), plus whatever it derives from `foldRegions` for the "unfolding scrolls header into view" behavior at line 796 — capture that via a ref to keep deps minimal.
- `onScroll` (passed through to `FileContentViewer`) — if it's defined inline in the parent, wrap it too. If `FileContentViewer` doesn't pass `onScroll` to `Row`, this one is lower priority but still cheap.

After this change, `Row.memo` actually does its job: a `setCurrentLine(ln)` only re-renders the previously-current row (loses background) and the newly-current row (gains background), not all 500 visible.

### Change B — Lazy overscan ballooning

In `aic-pipeline/src/components/FileContentViewer.tsx:302-330`, decouple the overscan inflation from `mousedown`. New mechanism:

- Keep the existing `selecting` boolean (`true` while mouse button is down inside the viewer). It no longer feeds the virtualizer directly.
- Add a new boolean `selectionScrolled`, initially `false`. It flips to `true` only when the user scrolls the container *while* `selecting === true`. It resets to `false` on `mouseup`.
- Virtualizer overscan: `24` when `selectionScrolled === false`, `80` when `selectionScrolled === true`. (Cap reduced from 500 to 80; 80 rows ≈ ~1600px of slack each side, which covers a typical drag-while-scrolling without re-mounting the original anchor.)

Implementation outline:

```ts
const [selecting, setSelecting] = useState(false);
const [selectionScrolled, setSelectionScrolled] = useState(false);

// existing mousedown/mouseup wiring stays;
// add a scroll listener that flips selectionScrolled when relevant.

useEffect(() => {
  if (!selecting) return;
  const el = containerRef.current;
  if (!el) return;
  const onScroll = () => setSelectionScrolled(true);
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => el.removeEventListener("scroll", onScroll);
}, [selecting]);

useEffect(() => {
  // When selection ends, drop the inflated overscan back to normal.
  if (!selecting) setSelectionScrolled(false);
}, [selecting]);

const virtualizer = useVirtualizer({
  count: visibleLines.length,
  getScrollElement: () => containerRef.current,
  estimateSize: () => 20,
  overscan: selectionScrolled ? Math.min(visibleLines.length, 80) : 24,
});
```

The existing `selecting` state is retained (it may be useful for future refinements; tests reference it), but the virtualizer no longer reacts to it directly.

## Trade-offs

- **Long drag-selects past ~80 rows of scroll lose their original anchor.** The browser's native `Selection` collapses when the anchor row unmounts. The previous cap was 500, so this only affects users dragging across more than ~1600px of scroll. If telemetry/feedback shows this is a real workflow, bump the cap (200, 300) — config knob only, no architectural change.
- **A single click still toggles `selecting` true→false rapidly.** With Change B in place, this no longer cascades into the virtualizer because `selectionScrolled` stays false throughout. The brief `selecting` flicker doesn't trigger the inflation.
- **`Row.memo` now actually works.** This means correctness becomes more sensitive to prop stability. Anything passed into `Row` that's not memoized (e.g., `lineOverlays.get(ln)` if `lineOverlays` itself is a new Map every render) could still cause re-renders. We're not auditing every prop in this spec — if a prop turns out to be unstable, fix it in a follow-up.

## Acceptance

**Before vs. after** on a real scope/script (validated manually):

1. Open Browse → Scripts → click a moderately large script (>500 lines).
2. Click somewhere in the script. The active-line highlight should appear with no perceptible lag.
3. Drag-select a paragraph of code within the visible viewport. Selection should track the mouse smoothly.
4. Drag-select while scrolling slowly past 1-2 screens. Selection should remain visible across the dragged range; brief overscan inflation is fine.
5. Drag-select across many screens (>5). Acceptable for the selection to break at the unmounted anchor — current behavior also breaks for very long drags.

**Profiling check:** in DevTools React Profiler, a single click on a large script should commit a frame with ≤30 `<Row>` components rendering (one viewport worth), not 500+. After Change A, a state change in `ScriptFileViewer` (e.g., setting `currentLine`) should commit only the previously-current and newly-current `<Row>`, not all visible.

**Regression coverage:** there are no existing unit tests for `FileContentViewer` or `ScriptFileViewer`. We're not adding one in this work — testing `useVirtualizer` interactions cleanly requires non-trivial test scaffolding that doesn't exist in the repo. The change is small enough that a focused manual smoke (the 5 numbered checks above) is the right level of verification. If a regression escapes, it'll be visible immediately in the next click.

## Out of scope

- Any change to the `ConfigsViewer.tsx` left-list virtualization (#2 from earlier ranking — separate effort).
- Any change to the analysis pipeline split (`extractCommentSpans` / `detectSymbols` / `detectReferences` / `computeFoldRegions`) — those affect mount/comment-toggle perf, not selection.
- Synchronous-to-async migration of the audit endpoint.
- Any new prop on `FileContentViewer` for tunable overscan caps.
