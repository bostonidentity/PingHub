# Parent-Journey Include Checkbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a selected master journey serve discovery-only — its dep tree stays visible for picking inner journeys, but a new per-parent checkbox (default checked) can exclude its own events from the pull.

**Architecture:** Frontend-only. A pure `runTreeNames(selected, excludedParents, innerChecked)` helper in `journey-filter.ts` computes the pull list; `JourneyHistoryPanel` holds new ephemeral `excludedParents` state and a pre-flight guard against an accidental empty (= unfiltered) pull; `JourneyDepPicker` renders a parent checkbox row above each section's inner-journey tree. No backend, runner, or report-format changes.

**Tech Stack:** Next.js (App Router, client components), TypeScript, vitest. Spec: `docs/superpowers/specs/2026-06-11-journey-parent-include-checkbox-design.md`.

All paths below are relative to `ping-aic-studio/`. Run all commands from `ping-aic-studio/`.

**Important repo note:** This repo's Next.js has breaking changes vs. its public versions (see `AGENTS.md`). The tasks below only touch React client components and a pure lib module — no Next.js APIs — so no Next docs reading is needed.

---

### Task 1: `runTreeNames` helper (TDD)

**Files:**
- Test: `src/lib/reports/journey-filter.test.ts` (append a new `describe` block)
- Modify: `src/lib/reports/journey-filter.ts` (append one function)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/reports/journey-filter.test.ts` (top of file already imports from `./journey-filter`; extend that import with `runTreeNames`):

```ts
import { buildJourneyQueryFilter, filterEventsByJourneys, parseTreeNames, runTreeNames, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
```

```ts
describe("runTreeNames", () => {
  it("returns [] (no filter) when no parents are selected, even with inner picks", () => {
    expect(runTreeNames([], [], [])).toEqual([]);
    expect(runTreeNames([], [], ["Inner1"])).toEqual([]);
  });

  it("returns the selected parents when nothing is excluded or inner-checked", () => {
    expect(runTreeNames(["Master"], [], [])).toEqual(["Master"]);
  });

  it("unions selected parents with checked inner journeys", () => {
    expect(runTreeNames(["Master"], [], ["Inner1", "Inner2"])).toEqual(["Master", "Inner1", "Inner2"]);
  });

  it("drops an excluded parent but keeps its inner picks", () => {
    expect(runTreeNames(["Master"], ["Master"], ["Inner1"])).toEqual(["Inner1"]);
  });

  it("only excludes the named parent when several are selected", () => {
    expect(runTreeNames(["A", "B"], ["A"], [])).toEqual(["B"]);
  });

  it("returns [] when every parent is excluded and nothing is inner-checked", () => {
    expect(runTreeNames(["Master"], ["Master"], [])).toEqual([]);
  });

  it("ignores excluded names that are not selected parents", () => {
    expect(runTreeNames(["A"], ["B"], [])).toEqual(["A"]);
  });

  it("dedupes a name that is both a selected parent and inner-checked", () => {
    expect(runTreeNames(["A", "B"], [], ["B"])).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reports/journey-filter.test.ts`
Expected: FAIL — `runTreeNames` is not exported (`SyntaxError`/`TypeError: runTreeNames is not a function`).

- [ ] **Step 3: Implement the helper**

Append to `src/lib/reports/journey-filter.ts`:

```ts
/**
 * Journeys a report run actually pulls: the selected parents minus any
 * excluded ones (parents kept selected only to expose their inner-journey
 * tree for picking), plus the checked inner journeys.
 *
 * No parents selected → [] (no filter at all); inner picks only ride along
 * with parents. NOTE: a non-empty selection can still produce [] (every
 * parent excluded, nothing checked) — callers must treat that as "nothing to
 * pull" and block the run, NOT fall through to an unfiltered pull.
 */
export function runTreeNames(selected: string[], excludedParents: string[], innerChecked: string[]): string[] {
  if (selected.length === 0) return [];
  const excluded = new Set(excludedParents);
  return [...new Set([...selected.filter((j) => !excluded.has(j)), ...innerChecked])];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reports/journey-filter.test.ts`
Expected: PASS (all `runTreeNames` tests plus the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/journey-filter.ts src/lib/reports/journey-filter.test.ts
git commit -m "feat(report): runTreeNames helper for parent-exclusion pull lists"
```

---

### Task 2: Panel state, pull-list wiring, and empty-pull guard

**Files:**
- Modify: `src/app/analyze/JourneyHistoryPanel.tsx` (state ~line 220, memo ~line 259, `run()` ~line 348)

- [ ] **Step 1: Add the `excludedParents` state**

In `JourneyHistoryPanel.tsx`, directly below the `innerChecked` state (line 220), add:

```ts
    // Selected parents whose OWN events are excluded from the pull (kept selected
    // only so their inner-journey tree stays visible for picking). Ephemeral,
    // like innerChecked — deliberately not in SavedSettings.
    const [excludedParents, setExcludedParents] = useState<string[]>([]);
```

- [ ] **Step 2: Replace the inline pull-list memo with the helper and add pruning**

Add `runTreeNames as computeRunTreeNames` to the existing import from `@/lib/reports/journey-filter` (the file already imports `MAX_SERVER_FILTER_JOURNEYS` from there — check the import list near the top and extend it). The alias avoids colliding with the local `runTreeNames` variable name, which the rest of the file already uses everywhere.

Replace the memo at lines 259–264:

```ts
    // Journeys actually pulled by a run: the selected parents plus any checked inner journeys.
    const runTreeNames = useMemo(
        // No parents selected → no filter at all; inner picks only ride along with parents.
        () => (selectedJourneys.length === 0 ? [] : [...new Set([...selectedJourneys, ...innerChecked])]),
        [selectedJourneys, innerChecked],
    );
```

with:

```ts
    // Journeys actually pulled by a run: selected parents minus excluded ones,
    // plus any checked inner journeys.
    const runTreeNames = useMemo(
        () => computeRunTreeNames(selectedJourneys, excludedParents, innerChecked),
        [selectedJourneys, excludedParents, innerChecked],
    );

    // An exclusion must never outlive its parent's selection (mirrors the dep
    // picker's pruning of inner picks whose parent was deselected).
    useEffect(() => {
        setExcludedParents((prev) => {
            const pruned = prev.filter((p) => selectedJourneys.includes(p));
            return pruned.length === prev.length ? prev : pruned;
        });
    }, [selectedJourneys]);
```

- [ ] **Step 3: Add the empty-pull pre-flight guard**

In `run()` (line 348), after the `setError(null);` line and BEFORE the `dataSource === "archive"` branch (the guard must protect both the live and archive paths — empty `treeNames` means "all journeys" in both):

```ts
        // Pre-flight: parents selected but every box unchecked → an empty filter
        // would pull/analyze EVERY journey, the opposite of the user's intent.
        if (selectedJourneys.length > 0 && runTreeNames.length === 0) {
            setError("Nothing selected to pull — check the journey or at least one inner journey.");
            return;
        }
```

The resulting top of `run()` reads:

```ts
    async function run() {
        if (!env || !from || !to) {
            setError("Environment, From, and To are required.");
            return;
        }
        setError(null);
        // Pre-flight: parents selected but every box unchecked → an empty filter
        // would pull/analyze EVERY journey, the opposite of the user's intent.
        if (selectedJourneys.length > 0 && runTreeNames.length === 0) {
            setError("Nothing selected to pull — check the journey or at least one inner journey.");
            return;
        }
        if (dataSource === "archive") { await runArchive(); return; }
```

- [ ] **Step 4: Verify it compiles and lints**

Run: `npx tsc --noEmit && npx eslint src/app/analyze/JourneyHistoryPanel.tsx`
Expected: no errors. (`excludedParents` is still unused by any UI — that's Task 3; eslint does not flag used-by-memo state.)

- [ ] **Step 5: Commit**

```bash
git add src/app/analyze/JourneyHistoryPanel.tsx
git commit -m "feat(report): excludedParents state, pull-list wiring, empty-pull guard"
```

---

### Task 3: Parent checkbox row in `JourneyDepPicker`

**Files:**
- Modify: `src/app/analyze/JourneyDepPicker.tsx` (props ~line 103, section render ~line 177, footer ~line 219)
- Modify: `src/app/analyze/JourneyHistoryPanel.tsx:745` (pass the new props)

- [ ] **Step 1: Extend the picker's props**

In `JourneyDepPicker.tsx`, change the component signature (line 103):

```ts
export function JourneyDepPicker({ env, parents, checked, onChange, excludedParents, onExcludedChange }: {
    env: string;
    parents: string[];
    checked: string[];
    onChange: (next: string[]) => void;
    /** Selected parents whose own events are excluded from the pull. */
    excludedParents: string[];
    /** Replace the excluded-parents list (same replace-wholesale contract as onChange). */
    onExcludedChange: (next: string[]) => void;
}) {
```

- [ ] **Step 2: Add the parent toggle and render the parent row**

Below the existing `toggle` function (line 158–160), add:

```ts
    const excludedSet = useMemo(() => new Set(excludedParents), [excludedParents]);
    const toggleParent = (name: string) => {
        onExcludedChange(excludedSet.has(name) ? excludedParents.filter((p) => p !== name) : [...excludedParents, name]);
    };
```

In the section render (line 184, inside `sections.map`), insert the parent row between the header `<div className="flex items-center gap-2">…</div>` and the `{tree.children.map(...)}` list:

```tsx
                        <div className="flex items-center gap-2">
                            <span className="w-3" />
                            <label className="flex items-center gap-2 text-xs text-slate-700">
                                <input
                                    type="checkbox"
                                    className="accent-sky-600"
                                    checked={!excludedSet.has(parent)}
                                    onChange={() => toggleParent(parent)}
                                />
                                <span>
                                    {parent}
                                    <span className="text-slate-500"> (include this journey&apos;s own events)</span>
                                </span>
                            </label>
                        </div>
```

(The `<span className="w-3" />` spacer aligns the checkbox with the child rows, which reserve that width for the expand/collapse button.)

- [ ] **Step 3: Update the footer text**

Replace the footer paragraph (lines 219–221):

```tsx
            <p className="text-[11px] text-slate-500">
                Checked inner journeys are pulled with the report so their nodes can nest under the parent&apos;s evaluator rows.
            </p>
```

with:

```tsx
            <p className="text-[11px] text-slate-500">
                Checked inner journeys are pulled with the report so their nodes can nest under the parent&apos;s evaluator rows.
                An unchecked parent is used for structure and picking only — its own events are not pulled.
            </p>
```

- [ ] **Step 4: Pass the new props from the panel**

In `JourneyHistoryPanel.tsx` line 745, replace:

```tsx
                    <JourneyDepPicker env={env} parents={selectedJourneys} checked={innerChecked} onChange={setInnerChecked} />
```

with:

```tsx
                    <JourneyDepPicker
                        env={env} parents={selectedJourneys} checked={innerChecked} onChange={setInnerChecked}
                        excludedParents={excludedParents} onExcludedChange={setExcludedParents}
                    />
```

- [ ] **Step 5: Verify it compiles and lints**

Run: `npx tsc --noEmit && npx eslint src/app/analyze/JourneyDepPicker.tsx src/app/analyze/JourneyHistoryPanel.tsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/analyze/JourneyDepPicker.tsx src/app/analyze/JourneyHistoryPanel.tsx
git commit -m "feat(report): parent include checkbox in inner-journey picker"
```

---

### Task 4: Full suite + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites, including the new `runTreeNames` block.

- [ ] **Step 2: Manual smoke test (no component-test infra for analyze panels)**

Run: `npm run dev`, open the Analyze → Journey History panel, then verify:

1. Select `kyid_2B1_MasterLogin` (uat) → "Inner journeys of kyid_2B1_MasterLogin" section shows a checked parent row at the top: `kyid_2B1_MasterLogin (include this journey's own events)`.
2. Uncheck the parent, check one inner journey (e.g. `kyid_2B1_KerberosMain`) → the >25-journeys warning math and Run still work; starting a run sends only the inner journey (job params `treeNames` in the run progress / `.jobs/<id>.json` contain just the inner name).
3. Uncheck the parent with NO inner journey checked → Run shows "Nothing selected to pull — check the journey or at least one inner journey." and no job starts.
4. Re-check the parent → behavior identical to before the change.
5. Deselect the parent journey entirely while it is excluded → re-selecting it shows the parent row checked again (exclusion was pruned).

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-06-11-journey-parent-include-checkbox-design.md`, change `**Status:** Approved` to `**Status:** Implemented (2026-06-11)`.

```bash
git add docs/superpowers/specs/2026-06-11-journey-parent-include-checkbox-design.md
git commit -m "docs(report): mark parent-include-checkbox spec implemented"
```
