# Journey Report — Per-Node Outcome Statistics

**Date:** 2026-06-09
**Status:** Implemented (node outcomes). Inner-tree nesting design has since
evolved — see the current reference, which supersedes the edge/heuristic notes
below for the UAT-style tenant:
`ping-aic-studio/docs/journey-report-node-outcomes.md`.

## Goal

Let the user, in the Journey History report, select one or more **specific node
instances** and see, for each, the distribution of its outcome values across the
run — outcomes are arbitrary strings (`TRUE`, `FALSE`, `Locked`, `User Not
Found`, …), not just true/false. Scope is the **whole report** (every attempt),
independent of whether the attempt ultimately succeeded or failed.

### What the user gets

A **hierarchical tree** of the journeys and their nodes for the run:

- Each **outer (entrypoint) journey** is a root; its nodes are listed beneath it.
- **Inner trees nest under the parent journey that invoked them**, recursively,
  to any depth — so the structure of inner-tree → child nodes → parent journey
  is visible at a glance.
- For each **node**: visit/traversal count + outcome distribution (count and %
  of each distinct outcome value).
- For each **inner-tree row**: its child nodes/trees, plus the **evaluator
  node's own outcome** (which inner-journey result it returned), linked
  best-effort (see below).

## Decisions (from brainstorming)

- **Selection unit:** specific node *instance*, not node type. Node type is not
  in the log payload, so it is not used for filtering.
- **Node identity / key:** `treeName + nodeName`. Display names are not unique
  across journeys.
- **Capture scope:** all node visits, not just pre-failure nodes.
- **Stats:** outcome distribution + visit count. (No time-series — out of scope.)
- **Display = hierarchical tree, no pagination.** Expand/collapse + text filter
  + expand-all/collapse-all manage size. Distinct-node count is small, so no cap.
- **Reused inner trees** (called from >1 parent) appear **under each parent**
  (union), flagged `reused`; their per-node stats are identical/merged.
- **Inner-tree evaluator outcome** is shown on the inner-tree row, linked to the
  inner tree by a **best-effort chronological heuristic**; falls back to
  nesting-only when no confident match.
- **Approach A:** aggregate everything during analysis; the UI renders the tree
  and filters client-side. One report run; number of nodes viewed has no effect
  on generation time.

## Hard constraint: node events require non-summary mode

`journey-report-runner.ts` fetches with two filters:

- `BROAD_FILTER` (default) → `AM-TREE-LOGIN-*` **and** `AM-NODE-LOGIN-COMPLETED`.
- `SUMMARY_FILTER` (when `summaryOnly` / "Rates only" is on) → `AM-TREE-LOGIN-*`
  only; **node events are dropped**.

Per-node outcomes only exist when node events are fetched. Therefore this
feature is populated **only when "Rates only" is off**. In a rates-only run the
`nodeStructure.nodes` array is empty and the UI shows a hint to re-run with it
off. (Tree *edges* could in principle be derived from `AM-TREE-LOGIN-*` alone,
but the feature is gated on detailed mode for a coherent view.) The
`nodeStructure` rollup travels inside `JourneyRollup`, so it merges correctly
across windows in long runs.

## Data model

The report carries **flat aggregates** (easy to merge across windows); the UI
composes the tree from them at render time.

### New types (`src/lib/reports/journey-history.ts`)

```ts
export interface NodeOutcomeStat {
  treeName: string;                  // owning tree (top open attempt's tree)
  nodeName: string;                  // internal name — key component
  displayName: string;               // UI label
  visits: number;                    // total AM-NODE-LOGIN-COMPLETED hits
  /** outcome value -> count. Visits with no nodeOutcome bucket under "(none)". */
  outcomes: Record<string, number>;
  /** Set when this node is the best-effort evaluator for an inner tree; names
   *  the child tree it invokes. Such nodes render as the inner-tree row, not as
   *  a standalone node, to avoid double display. */
  evaluatorForTree?: string;
}

/** One observed parent-tree → child-tree nesting relationship, aggregated. */
export interface TreeEdge {
  parent: string;                    // parent treeName
  child: string;                     // inner treeName invoked under parent
  invocations: number;               // times this nesting was observed
  /** Best-effort evaluator node (by nodeName) in the parent for this edge. */
  evaluatorNodeName?: string;
}

export interface NodeStructure {
  outerTrees: string[];              // trees seen as entrypoint (tree roots)
  edges: TreeEdge[];                 // parent → child nesting
  nodes: NodeOutcomeStat[];          // per-node outcome stats (leaves)
}
```

Map keys use a NUL separator to avoid collisions with names containing spaces:
nodes keyed by parent tree + node name, edges by parent tree + child tree.

### Wiring into existing types

- `JourneyHistoryReport` gains `nodeStructure: NodeStructure`.
- `JourneyRollup` (`Pick<…, "summary" | "perJourney">`) is extended to include
  `"nodeStructure"` so windowing carries it.
- `emptyRollup()` seeds an empty `nodeStructure`
  (`{ outerTrees: [], edges: [], nodes: [] }`).

## Analysis changes (`analyzeJourneyHistory`)

The transaction walk already maintains a LIFO `stack` of open attempts that
handles arbitrary inner-tree nesting depth. Add three report-scoped maps and one
small per-stack bookkeeping field.

**Per-node outcomes.** In the `node-completed` branch, in addition to the
existing failure-attribution stash, record into a report-scoped node map:
- `treeName` = top open attempt's `treeName`; if no open attempt (orphan/pending
  node), attribute to `outerTreeName ?? "(unknown)"`.
- `nodeName` = `info.nodeName ?? info.displayName ?? "(unknown)"`.
- `displayName` = `info.displayName ?? info.nodeName ?? "(unknown)"`.
- `visits += 1`; `outcomes[info.nodeOutcome ?? "(none)"] += 1`.

**Tree nesting edges.** In the `tree-init` branch, when the new tree is *not*
the outer one (`stack.length > 0`), record an edge from the current top's
`treeName` (parent) to the new `treeName` (child), incrementing `invocations`.
Collect `outerTrees` from the first push of each transaction.

**Evaluator linkage (best-effort).** When an inner tree's `tree-completed` pops
the stack, mark the now-top (parent) attempt as *awaiting an evaluator* for that
child tree. The **next** `node-completed` attributed to that parent is treated
as the evaluator: set `evaluatorNodeName` on the `(parent, child)` edge to that
`nodeName`, and tag that node's `NodeOutcomeStat.evaluatorForTree = child`.
Rationale: AIC emits the `InnerTreeEvaluatorNode`'s `AM-NODE-LOGIN-COMPLETED`
(carrying the inner result as its outcome) in the parent immediately after the
inner tree completes. If no node-completed follows before the parent itself
completes, the edge keeps no evaluator and the UI shows nesting only.

**Emit.** `report.nodeStructure = { outerTrees, edges, nodes }`, `nodes` sorted
by `visits` desc. No cap — distinct-node and edge counts are inherently small
(bounded by journey structure, not traffic).

## Merge changes (`mergeRollup`)

Fold `nodeStructure` alongside the per-journey fold:
- **nodes:** group by node key; `visits` and per-`outcomes` additive; carry
  `evaluatorForTree` (any non-empty wins). Re-sort by `visits` desc.
- **edges:** group by edge key; `invocations` additive; `evaluatorNodeName` by
  most-common across windows. **outerTrees:** set-union.

This mirrors the additive `topFailureNodes` merge already present.

## Runner / API

- `journey-report-runner.ts` line ~471 builds the merged rollup from
  `{ summary, perJourney }`; add `nodeStructure: winReport.nodeStructure`.
- The `rollupOnly: true` persisted report (line ~553) already serializes the
  rollup; including `nodeStructure` makes it available to the UI for both
  single-window and multi-window runs.
- No new request parameters. The feature is purely additive on the existing
  non-summary fetch. Job request validation
  (`api/analyze/journey-history/jobs/route.ts`) is unchanged.

## UI (`src/app/analyze/JourneyHistoryPanel.tsx`)

**Decision: a hierarchical tree, no pagination.** Add a collapsible **"Node
outcomes"** section below the summary cards, visible whenever
`report.nodeStructure?.nodes.length`.

**Composing the tree (client-side from `nodeStructure`):**
- Roots = `outerTrees`.
- For a tree `T`: children are (a) **child trees** = `edges` where
  `parent === T` (rendered as inner-tree rows), and (b) **nodes** =
  `nodes` where `treeName === T` **excluding** those whose `evaluatorForTree`
  marks them as an inner-tree evaluator (they render as the inner-tree row
  instead, to avoid double display).
- Recurse into child trees. **Cycle guard:** track the tree names on the current
  path; if a child would re-enter an ancestor (pathological recursion), stop and
  render a `↻ shown above` marker instead of recursing.
- A child tree reachable from multiple parents renders **under each** (union),
  flagged `reused` when it has >1 distinct parent.

**Rows:**
- **Tree row** (`outer` / `inner` badge): expands to reveal its children. For an
  inner tree, the expanded panel also shows the **evaluator outcome** — the
  outcome distribution of the `evaluatorNodeName` node (looked up in `nodes`),
  labeled with the evaluator node name and noted as a best-effort link.
- **Node row:** expands to its outcome breakdown — each distinct outcome value
  with count and % of that node's visits, sorted by count desc; `(none)` is a
  normal row. Breakdown is **rendered lazily on expand**.

**Controls:** a **text filter** matching node + tree names that auto-expands
matching branches, plus **Expand all / Collapse all**. Outer journeys expanded
by default; deeper levels collapsed.

When `summaryOnly` was used (empty `nodeStructure`): show the hint *"Node
outcome stats need node-level events. Re-run with 'Rates only' off."*

The section is **always available** on detailed (non-summary) runs — no extra
opt-in toggle.

## Out of scope (YAGNI)

- Node *type* selection/filtering (node type is not in the logs).
- Outcome-over-time / trend charts.
- Per-outcome breakdown split by attempt success/fail.
- Pagination (superseded by the tree view).
- Linking an inner tree to the **specific evaluator node with certainty** — the
  link is a best-effort heuristic; exact node-type identification would need a
  journey-config lookup.

## Testing

Unit tests in the existing journey-history test suite:
1. Per-node `outcomes`/`visits` correct for repeated visits with varied outcomes
   (incl. a `(none)` bucket).
2. Node attribution to the correct `treeName` for inner-tree nodes (multi-level
   nesting).
3. `edges` + `outerTrees` correctly reconstruct a 3-level nesting; depth is
   unbounded.
4. **Evaluator linkage:** the parent node-completed following an inner tree's
   completion is tagged `evaluatorForTree` and set as the edge's
   `evaluatorNodeName`; no-following-node case leaves the edge evaluator-less.
5. Reused inner tree (same child under two parents) yields two edges, one node
   set.
6. `mergeRollup` sums node `visits`/`outcomes` and edge `invocations`, unions
   `outerTrees`, across two windows.
7. Summary-only run yields empty `nodeStructure`.
8. UI tree composer: cycle guard renders `↻ shown above` rather than recursing.

## Implementation note

Per `ping-aic-studio/AGENTS.md`, this Next.js fork has breaking changes — read
the relevant guide under `node_modules/next/dist/docs/` before touching any
route/page code.

## Files to change

- `src/lib/reports/journey-history.ts` — new types, analysis (node outcomes +
  tree edges + evaluator linkage), merge.
- `src/lib/reports/journey-report-runner.ts` — include `nodeStructure` in merged
  rollup and persisted report.
- `src/app/analyze/JourneyHistoryPanel.tsx` — node-outcomes **tree** section
  (client-side tree composer from `nodeStructure`, expand/collapse, filter,
  lazy breakdowns). Likely a small `NodeOutcomeTree.tsx` child component.
- Tests alongside the existing journey-history tests.
