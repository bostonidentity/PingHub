# Script Viewer Selection & Highlight Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the one inline callback prop reaching `FileContentViewer` and decouple the virtualizer's overscan inflation from `mousedown`, so clicking and short drag-selects in the script viewer no longer trigger render bursts of hundreds of `<Row>` components.

**Architecture:** Two surgical edits in two files. Change A wraps `onLineClick` in `useCallback` so `Row.memo` actually shallow-compares cleanly. Change B introduces a `selectionScrolled` state that defers the virtualizer's overscan increase from "mouse-button is down" to "mouse-button is down AND user has scrolled the container," and lowers the cap from 500 rows to 80.

**Tech stack:** React 19, TypeScript, `@tanstack/react-virtual`. The repo's `aic-pipeline/AGENTS.md` warns Next.js APIs may differ from training data — this work doesn't touch any Next.js APIs, so that caveat is informational only. Tests run with `npx vitest run <path>` (single file) or `npm test` (full suite); manual UI validation requires `npm run dev`.

**Spec:** `aic-pipeline/docs/superpowers/specs/2026-04-28-script-viewer-selection-perf-design.md`

---

## File map

**Modified files:**
- `src/components/ScriptFileViewer.tsx` — add `useCallback` for the `onLineClick` prop currently inlined at the JSX call site (line 1137).
- `src/components/FileContentViewer.tsx` — split overscan inflation into `selecting` (mousedown) + new `selectionScrolled` (scrolled while selecting); reduce cap from 500 to 80.

**No new files. No new tests** (the repo has no existing unit tests for either component, and stubbing `useVirtualizer` cleanly is out of scope per the spec). Verification is via `tsc --noEmit`, `npm test` (regression sweep on the existing suite), and a manual smoke pass.

---

## Task 1: Stabilize the `onLineClick` callback prop

**Files:**
- Modify: `src/components/ScriptFileViewer.tsx:540-1137`

The `onLineClick` arrow at line 1137 is the only unstable callback reaching `<FileContentViewer>`. `handleViewerScroll` (line 875) and `toggleFold` (line 776) are already `useCallback`'d. `lineOverlays` (line 895) is already `useMemo`'d. Wrapping `onLineClick` is the entire change for Change A.

- [ ] **Step 1: Add a memoized `handleLineClick` callback alongside the other `useCallback`s.**

In `aic-pipeline/src/components/ScriptFileViewer.tsx`, find `handleGoToLine` (declared with `useCallback` around line 762). Just below it (or at any nearby location among the existing callbacks — it's a top-level function declaration in the component body), insert:

```ts
  // Stable reference so FileContentViewer's memoized <Row> components don't
  // re-render every visible row whenever any state in this component changes.
  // setCurrentLine is a stable setter, so the dep array is empty.
  const handleLineClick = useCallback((ln: number) => {
    setCurrentLine(ln);
  }, []);
```

(`setCurrentLine` is the React state setter from line 540: `const [currentLine, setCurrentLine] = useState<number | undefined>(highlightLine);`. State setters from `useState` are guaranteed stable across renders, so the empty dep array is correct and won't trigger any lint warning from `react-hooks/exhaustive-deps`.)

- [ ] **Step 2: Use the memoized callback at the JSX call site.**

In the same file, find the `<FileContentViewer>` JSX block (around line 1123–1138). Change line 1137 from:

```tsx
              onLineClick={(ln) => setCurrentLine(ln)}
```

to:

```tsx
              onLineClick={handleLineClick}
```

- [ ] **Step 3: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors. If `react-hooks/exhaustive-deps` flags the empty dep array, the warning is incorrect (state setters are stable) — but the rule sometimes wants the setter listed explicitly. If so, change `[]` to `[setCurrentLine]`; that's also valid.

- [ ] **Step 4: Run the full Vitest suite to confirm no regressions.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass (the existing suite — no test exists for ScriptFileViewer specifically, but other tests must still pass).

- [ ] **Step 5: Commit.**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/components/ScriptFileViewer.tsx
git commit -m "$(cat <<'EOF'
perf(scripts): stabilize onLineClick so Row.memo applies

The inline (ln) => setCurrentLine(ln) was a fresh function ref on every
render, defeating the memo on FileContentViewer's Row component and
re-rendering every visible row on any state change. With useCallback in
place, only the previously-current and newly-current rows commit on a
line click.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Lazy overscan ballooning during selection

**Files:**
- Modify: `src/components/FileContentViewer.tsx:296-330`

Today the virtualizer's overscan jumps from `24` to `Math.min(visibleLines.length, 500)` the moment the user mousedown's anywhere inside the container. We add a second state that gates the inflation behind "user actually scrolled while selecting" and reduce the cap to 80.

- [ ] **Step 1: Add the `selectionScrolled` state alongside the existing `selecting` state.**

In `aic-pipeline/src/components/FileContentViewer.tsx`, find the existing `selecting` state and effect block (around lines 302–317). The current code is:

```ts
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // Only react to primary-button presses inside the content container.
      if (e.button !== 0) return;
      const el = containerRef.current;
      if (el && el.contains(e.target as Node)) setSelecting(true);
    };
    const onMouseUp = () => setSelecting(false);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
```

Replace it with:

```ts
  // `selecting` is true while the primary mouse button is down inside the
  // content container. `selectionScrolled` is the actual signal that drives
  // the virtualizer overscan — it stays false until the user scrolls during a
  // selection. This means a click-release (or a short drag inside the
  // viewport) never triggers an overscan inflation, and only an actual
  // drag-and-scroll does. Cap is 80 rows, not 500 — covers ~1600px of slack
  // per side, enough for typical drag-while-scrolling without a render burst.
  const [selecting, setSelecting] = useState(false);
  const [selectionScrolled, setSelectionScrolled] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // Only react to primary-button presses inside the content container.
      if (e.button !== 0) return;
      const el = containerRef.current;
      if (el && el.contains(e.target as Node)) setSelecting(true);
    };
    const onMouseUp = () => {
      setSelecting(false);
      setSelectionScrolled(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Only attach the scroll listener while a selection is in progress. When
  // selection ends (mouseup), the effect tears down naturally because
  // `selecting` flips back to false.
  useEffect(() => {
    if (!selecting) return;
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => setSelectionScrolled(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [selecting]);
```

- [ ] **Step 2: Update the virtualizer's `overscan` to read from `selectionScrolled`.**

In the same file, find the `useVirtualizer` call (around lines 319–330). Replace the entire call:

```ts
  const virtualizer = useVirtualizer({
    count: visibleLines.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 20,
    // Ordinary scrolling: 24 rows of slack above/below (~480px each side).
    // During an active selection we bump overscan so rows the user has
    // already anchored don't unmount as they scroll, BUT we cap it so a
    // mousedown on a 5 000-line file doesn't stall rendering the moment
    // the user clicks. 500 rows of slack each way covers ~10 000px of
    // scroll — more than enough for the vast majority of drag selects.
    overscan: selecting ? Math.min(visibleLines.length, 500) : 24,
  });
```

with:

```ts
  const virtualizer = useVirtualizer({
    count: visibleLines.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 20,
    // Ordinary scrolling: 24 rows of slack above/below (~480px each side).
    // While the user is drag-selecting AND has scrolled the container, we
    // bump overscan so rows the user has already anchored don't unmount as
    // they scroll past — the browser's native Selection anchors to DOM
    // nodes, and losing them mid-drag collapses the selection. The cap is
    // 80 rows (~1600px each side) — enough for typical drag-while-scrolling
    // without producing a render burst on every mousedown. Long drags past
    // ~80 rows of scroll will lose their anchor; that's an acceptable
    // trade-off vs. the per-click lag the previous 500-row cap caused.
    overscan: selectionScrolled ? Math.min(visibleLines.length, 80) : 24,
  });
```

- [ ] **Step 3: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full Vitest suite.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/components/FileContentViewer.tsx
git commit -m "$(cat <<'EOF'
perf(scripts): defer virtualizer overscan inflation until scroll-while-selecting

Mousedown was flipping selecting=true and bumping overscan to up to 500
rows immediately, mounting hundreds of <Row> components in one frame on
every click. The inflation now waits for an actual scroll during the
selection, and the cap is reduced from 500 to 80 rows.

Click-release and short drag-selects within the viewport no longer
trigger any overscan change. Drag-and-scroll inflates to 80 rows of
slack per side — enough to keep a 1600px-tall selection anchored
without breaking the browser's native Selection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Manual smoke + final green check

**Files:** none (validation only)

- [ ] **Step 1: Run the full quality gate.**

```bash
cd aic-pipeline && npx tsc --noEmit
cd aic-pipeline && npm run lint
cd aic-pipeline && npm test
```

All three must succeed (no errors). If anything fails, STOP and investigate; do not commit anything until clean.

- [ ] **Step 2: Manual smoke in the dev server.**

```bash
cd aic-pipeline && npm run dev
```

Navigate to `http://localhost:3000/configs` (Browse tab). Pick any environment with pulled config; in the scope picker select "scripts" (or any scope with sizeable script files). Open a script of at least 500 lines.

Run through the spec's 5 acceptance checks:

1. **Click somewhere in the script.** The active-line highlight (subtle background + left accent) should appear with no perceptible lag. Compare to before: it should feel snappier.
2. **Drag-select a paragraph of code within the visible viewport.** Selection tracks the mouse smoothly; no stutter at the start of the drag.
3. **Drag-select while scrolling slowly past 1–2 screens.** Selection remains visible across the dragged range. The overscan inflates briefly when scrolling starts; that's expected.
4. **Drag-select across many screens (>5).** Acceptable for the selection to break at the unmounted anchor — the cap is 80 rows now (was 500). If breakage is jarring in real workflows, file a follow-up to bump the cap.
5. **Open React DevTools → Profiler tab → record a session, click the script, stop recording.** The committed frame should show ≤30 `<Row>` components rendering, not 500+.

Stop the dev server.

- [ ] **Step 3: No commit needed.**

This task is validation-only. If Steps 1–2 surfaced regressions, file fix tasks before declaring the work done.

---

## Self-review notes

**Spec coverage:**
- Spec § "Approach" → Change A → Task 1 ✓
- Spec § "Approach" → Change B → Task 2 ✓
- Spec § "Acceptance" → Task 3 (manual smoke + DevTools profile) ✓
- Spec § "Trade-offs" → captured inline in Task 2's commit message + the comment in the new `useVirtualizer` call ✓
- Spec § "Out of scope" → no tasks here, by design ✓

**No placeholders:** every step has either concrete code or an exact command. The only manual step is the dev-server smoke in Task 3, which is what the spec calls for explicitly.

**Type / name consistency:** `selecting`, `selectionScrolled`, `setSelectionScrolled`, `handleLineClick` are all consistent across the two task code blocks. `setCurrentLine` is the existing state setter from `ScriptFileViewer.tsx:540` — verified before writing.

---

## Notes for the implementing engineer

- **No new tests.** The two affected components have no existing unit tests, and stubbing `useVirtualizer` cleanly is non-trivial. The spec explicitly accepts manual smoke + the existing regression suite as the verification level.
- **`@tanstack/react-virtual`** is already a dependency — no install needed.
- **Don't push without an explicit user request.** Commit locally throughout the plan; pushing is the user's call.
- **The `scope: "interrupted"` and other unrelated state machinery** from the recent data-pull feature are unaffected by this work — these two files are pure UI for the configs Browse tab.
