# Journey Report: Inner-Tree Nesting via Trace Correlation + Inner-Journey Picker

**Date:** 2026-06-10
**Status:** Approved design, pre-implementation
**Background:** `docs/journey-report-node-outcomes.md` §3–§4 (AIC logging facts, data
validation on the uat tenant). Builds on the node-outcomes feature
(`docs/superpowers/specs/2026-06-09-journey-node-outcome-stats-design.md`).

## Problem

The Journey History report's "Node outcomes" tree can only nest inner journeys
under their `IJ:` evaluator when the tenant emits inner-tree
`AM-TREE-LOGIN-INITIATED`/`COMPLETED` events. The uat tenant emits neither, so
nesting is inert there: inner journeys appear as flat roots (when their events
are pulled) and `IJ:` evaluators are leaves. Separately, pulling inner-journey
events requires knowing and hand-typing their tree names, because selecting only
the parent journey server-side filters the children's events away.

## Decisions (settled with user)

1. **Scope:** trace-correlation nesting (analyzer + tree UI) and a pre-run
   inner-journey picker resolved from config. Node-level pull filtering is OUT
   of scope (separate use case; queryFilter support unverified).
2. **Stats scope:** global per tree (current model). A node's visits/outcomes
   aggregate all invocations of its tree in the dataset, shown identically
   wherever the tree appears in the nesting. Edge rows already carry
   `invocations` for per-parent context. Path-scoped stats are a possible later
   feature; nothing in this design precludes them, but no provision is built.
3. **Picker UX:** tree checklist. Selecting a journey reveals its inner-journey
   closure (recursive, from config) as an indented checklist, all unchecked by
   default, with a per-parent "select all". No auto-include.

## Architecture

Two independent, independently shippable units:

- **Unit 1 — trace correlation** (`src/lib/reports/journey-history.ts` only).
  Changes how `nodeStructure` is computed. The `NodeStructure` / `TreeEdge` /
  `NodeOutcomeStat` shapes are unchanged, so `mergeNodeStructure`, the persisted
  report format, and `NodeOutcomeTree` rendering are untouched. Old persisted
  reports remain readable.
- **Unit 2 — inner-journey picker** (new API route + `JourneyHistoryPanel` UI,
  reusing `src/lib/resolve-journey-deps.ts`). Its only output is additional
  names in `treeNames`; the runner, filter, and analyzer are unaware of it.

Nesting works without the picker (hand-select parent + children); the picker
just makes the selection discoverable and cheap.

## Unit 1: Analyzer changes

All in `src/lib/reports/journey-history.ts`.

### Trace key

New helper `traceOf(transactionId: string): string` — returns the 2nd
`-`-segment of `00-<trace>-<span>-01/<counter>`. If the format doesn't match,
returns the full `transactionId` (graceful degradation to current grouping).
Rationale: nested journeys within one flow can carry different full
`transactionId`s but always share the trace segment (validated on uat: 3,623 of
7,552 traces span >1 journey).

### Node attribution

Each `AM-NODE-LOGIN-COMPLETED` is attributed to its **own** `info.treeName` at
event time when building `nodeMap` (visit counts + outcome tallies). This
replaces buffer-until-COMPLETED attribution **for node stats only** and fixes
attribution universally (INITIATED-less tenants included). Attempt
reconstruction — success rates, per-attempt paths, failure drill-down — keeps
its existing transactionId-based pairing/buffering logic, untouched.

### Edge pass (evaluator-anchored)

1. Group node-completed events by `traceOf(transactionId)`.
2. Sort each trace's events by timestamp; tiebreak with the numeric `/<counter>`
   suffix of `transactionId`.
3. Walk in order. Every event with `nodeType === "InnerTreeEvaluatorNode"`
   emits one edge:
   - **parent** = the evaluator event's own `treeName`;
   - **child** = the `treeName` of the contiguous block of events immediately
     preceding the evaluator whose `treeName` differs from the parent's;
   - **tiebreak** when the preceding block is ambiguous (interleaved children):
     prefer the candidate tree whose name contains the evaluator's
     `displayName` suffix (`IJ: MFA` → prefer trees matching `MFA`,
     case-insensitive substring).
   - The edge's `invocations` increments per occurrence; `evaluatorNodeName` is
     set from the evaluator event.
4. The evaluator's node stat gets `evaluatorForTree = child`, replacing the
   current "last-COMPLETED-is-the-inner-tree" heuristic with the authoritative
   `nodeType` signal.

Multi-level nesting needs no recursion: every evaluator at any depth emits its
own edge, and the edge set forms the tree.

### Single edge source (supersedes INITIATED-derived edges)

The evaluator-anchored pass is the **sole** source of edges. The existing
INITIATED-based edge derivation and the "last-COMPLETED" evaluator heuristic
are both removed. Rationale: edges only matter when node events are in the
pull (the node-outcomes section requires them), and wherever node events
exist, evaluator node events exist — so INITIATED-derived edges are redundant
at best and double-count `invocations` at worst on tenants that emit both.

### Outer trees

A tree is outer iff it is the tree of the **first** event of at least one
trace. This stops pulled-along inner journeys from appearing as spurious roots
while keeping a genuinely standalone run of that same journey a root.

## Unit 2: Inner-journey picker

### Lib

`src/lib/resolve-journey-deps.ts` gains
`resolveJourneyDepTree(configDir: string, journeyName: string): JourneyDepNode`
alongside the flat resolver:

```ts
interface JourneyDepNode {
  name: string;
  children: JourneyDepNode[];
  missing?: true;   // referenced by an InnerTreeEvaluatorNode but no config dir found
  repeated?: true;  // already expanded elsewhere in this tree; children omitted
}
```

Discovery mechanics are identical to the existing resolver (scan
`realms/<r>/journeys/<name>/nodes/*.json` for `_type._id ===
"InnerTreeEvaluatorNode"`, child name from `nd.tree`), with a visited set: a
journey reached a second time is emitted with `repeated: true` and no children.

### API

`GET /api/analyze/journey-deps?env=<env>&journey=<name>` →
`{ tree: JourneyDepNode, flat: string[] }` (flat = de-duped closure, excluding
the root). Env/config-dir resolution mirrors `/api/analyze/journeys`. Unknown
journey → 404 with a message; config dir absent → same handling as the
journeys route.

### UI (`JourneyHistoryPanel`)

- When a journey selected in `JourneyMultiSelect` has a non-empty closure, an
  indented checklist of its `JourneyDepNode` tree renders beneath the selector.
  All entries unchecked by default. Per-parent "select all". `missing` entries
  greyed out and uncheckable; `repeated` entries shown without children.
- Checked names are merged (de-duped) into the run's `treeNames`, so they flow
  through the existing server-side filter, job params, and the saved report's
  `selectedJourneys` with zero downstream changes.
- Dep trees are fetched lazily per selected journey and cached per env in
  component state; checklist state is ephemeral (not persisted across panel
  reloads).
- **>25 warning:** when total selected names exceed `MAX_SERVER_FILTER_JOURNEYS`
  (25), show a non-blocking warning that the run will fall back to a broad pull
  with client-side filtering (slower); the run itself proceeds as today.

## Error handling & accepted limits

| Case | Behavior |
|---|---|
| Unparseable `transactionId` | `traceOf` falls back to full ID; grouping degrades to current behavior |
| Evaluator with no preceding foreign-tree block (child events outside window, or child not selected) | No edge emitted; `IJ:` row stays a leaf with its outcome bar (today's behavior) |
| Trace split across window boundary | Events don't correlate across windows; accepted (traces are sub-second vs. hour-scale windows) |
| Interleaved inner journeys in one trace | Edge may be misattributed; mitigated by name-hint tiebreak; documented in the reference doc |
| Missing sub-journey config / config cycles | Resolver marks `missing` / `repeated`; UI greys out / stops expansion; `NodeOutcomeTree`'s existing cycle guard protects rendering regardless |
| Rates-only run | Unchanged: no node events, existing hint shown |

## Testing

### `src/lib/reports/journey-history.test.ts` (fixture-driven)

- `traceOf`: standard format, and fallback on malformed IDs.
- Own-`treeName` attribution on an INITIATED-less fixture (no `(unknown)`
  bucket, correct per-tree counts).
- Single evaluator → one edge with correct parent/child/`evaluatorNodeName`.
- Three-level chain (Master → IJ:MFA → MFA tree → IJ:Risk → Risk tree):
  both edges present; `evaluatorForTree` set on both evaluator nodes.
- Differing full `transactionId`s sharing one trace segment still correlate.
- Interleaved children before one evaluator → name-hint tiebreak picks the
  matching tree.
- Windowed merge (`mergeRollup`) preserves and sums trace-derived edges.
- INITIATED-emitting fixture: edges and `invocations` come solely from the
  evaluator pass — assert exact counts (no double-counting from INITIATED
  events).
- Outer-tree rule: pulled-along inner journey is not a root; same journey run
  standalone in another trace is.

### `src/lib/resolve-journey-deps.test.ts`

- Dep tree shape for a 3-level closure; cycle → `repeated`; dangling reference
  → `missing`.

### Manual validation

Re-analyze the retained-raw uat dataset (no re-pull needed) and confirm
MasterLogin → Kerberos / PTAJIT / MFA nesting matches the known trace in
`docs/journey-report-node-outcomes.md` §3.3.

## Out of scope

- Node-level pull filtering (nodeId queryFilter clause) — separate feature,
  needs tenant-side queryFilter verification first.
- Path-scoped node stats — possible follow-up; would key stats by invocation
  path and require a `nodeStructure` format extension.
- Raising `MAX_SERVER_FILTER_JOURNEYS` past 25 — untested against AIC URL/query
  limits.
