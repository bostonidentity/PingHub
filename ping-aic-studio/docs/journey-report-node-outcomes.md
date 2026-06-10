# Journey Report — Node Outcomes & Inner-Tree Analysis

Reference for the per-node outcome feature of the Journey History report, and —
more importantly — the **hard-won facts about how AIC logs journeys and inner
trees**, which dictate what this feature can and cannot show.

Related code:
- `src/lib/reports/journey-history.ts` — analyzer (events → report + `nodeStructure`)
- `src/lib/reports/journey-report-runner.ts` — background pull/window/merge
- `src/app/analyze/JourneyHistoryPanel.tsx` — report UI
- `src/app/analyze/NodeOutcomeTree.tsx` — the node-outcomes tree widget
- Design spec: `docs/superpowers/specs/2026-06-09-journey-node-outcome-stats-design.md`

---

## 1. What the feature does

In the Journey History report, below the per-journey rollup, a **"Node outcomes"**
section shows, per node:

- **visit/traversal count** (how many `AM-NODE-LOGIN-COMPLETED` hits), and
- **outcome distribution** — count and % of each distinct `nodeOutcome` value
  (arbitrary strings: `true`, `false`, `noSession`, `Locked`, `(none)`, …).

It renders as a collapsible **tree**: outer journeys → their nodes, with inner
trees nested underneath; filter box + Expand all / Collapse all; click a node to
see its outcome bars.

The data is a flat `nodeStructure` aggregate computed during analysis and merged
across windows; the UI composes the tree client-side.

### Status (2026-06-09)

| Piece | State |
|---|---|
| Per-node visit + outcome stats | **Implemented** |
| `nodeStructure` in report + windowed merge | **Implemented** |
| Node attribution for INITIATED-less tenants (buffer→COMPLETED) | **Implemented** |
| "Expand all" expands tree rows **and** node breakdowns | **Implemented (bugfix)** |
| Inner-tree nesting via parent/child **edges** | **Removed (2026-06-10)** — superseded by trace correlation |
| Inner-tree nesting via **trace correlation** | **Implemented (2026-06-10)** (see §4) |
| Inner-journey picker (config-resolved closure checklist) | **Implemented (2026-06-10)** |
| Hint shown when no node data (rates-only run) | **Implemented** |

---

## 2. Data model (`nodeStructure`)

```ts
interface NodeOutcomeStat {
  treeName: string;            // owning tree
  nodeName: string;            // internal name (key component)
  displayName: string;         // UI label
  visits: number;
  outcomes: Record<string, number>;   // outcome value -> count; "(none)" bucket
  evaluatorForTree?: string;   // set if this node is the inner-tree evaluator
}
interface TreeEdge { parent: string; child: string; invocations: number; evaluatorNodeName?: string; }
interface NodeStructure { outerTrees: string[]; edges: TreeEdge[]; nodes: NodeOutcomeStat[]; }
```

`nodeStructure` is added to `JourneyHistoryReport` and to `JourneyRollup`
(optional there, so legacy rollups still merge). `mergeRollup` folds it
additively across windows. Map keys use a NUL separator.

---

## 3. How AIC logs journeys & inner trees (CRITICAL)

These facts come from inspecting real retained-raw logs on the **uat** tenant
plus Ping docs. They explain every surprising behavior of this feature.

### 3.1 Event shape

`AM-NODE-LOGIN-COMPLETED` (source `am-authentication`) fires per node. Payload:

```jsonc
{ "eventName": "AM-NODE-LOGIN-COMPLETED",
  "transactionId": "00-<trace>-<span>-01/<counter>",
  "entries": [{ "info": {
      "displayName": "IJ: MFA",
      "nodeId": "ee39d644-…",
      "nodeOutcome": "true",
      "nodeType": "InnerTreeEvaluatorNode",   // ← nodeType IS present
      "treeName": "kyid_2B1_MasterLogin"       // ← each node carries its own tree
  }}]}
```

> **`nodeType` and per-node `treeName` are both present.** An earlier assumption
> that node type wasn't in the logs was **wrong**.

### 3.2 This tenant omits `AM-TREE-LOGIN-INITIATED`

The uat tenant emits **only** `AM-NODE-LOGIN-COMPLETED` + `AM-TREE-LOGIN-COMPLETED`
— **zero** `AM-TREE-LOGIN-INITIATED`. The analyzer already reconstructs attempts
from `COMPLETED` + buffered nodes for this case. Consequence for node stats: a
node's owning tree isn't known until its `COMPLETED` arrives, so buffered nodes
must be attributed **at COMPLETED time** (or by their own `info.treeName`) — not
eagerly, or they leak into an `(unknown)` bucket and vanish from the tree. This
was the cause of the "every node shows 41 visits" bug.

### 3.3 Inner trees DO log their own nodes — under their own tree name

The decisive finding. When a parent journey hits an `InnerTreeEvaluatorNode`
(displayName like `IJ: MFA`), the **child journey runs and emits its own
`AM-NODE-LOGIN-COMPLETED` events tagged with the child's `treeName`**
(e.g. `kyid_2B1_KerberosMain`, `kyid_2B1_PTAJITMain`). The parent then logs the
`IJ: …` evaluator node (with the child's overall `true`/`false` result).

Example, one trace, ordered:

```
[kyid_2B1_MasterLogin]  noSession-PingOne
[kyid_2B1_MasterLogin]  Page Node
[kyid_2B1_KerberosMain] Script: Enable Kerberos Authentication   ← child's own node
[kyid_2B1_MasterLogin]  IJ: Kerberos                              ← parent evaluator, right after
[kyid_2B1_PTAJITMain]   Script - isKYID2BJourney
[kyid_2B1_PTAJITMain]   Configuration Provider
```

Nesting is **multi-level**: `IJ:EvaluateRiskLevel` appears inside
`kyid_2B1_MFA_RegistrationAndAuthentication`, `JIT` inside `kyid_2B1_PTAJITMain`,
etc. So `MasterLogin → IJ: MFA → MFA_Reg… → IJ:EvaluateRiskLevel → …`.

### 3.4 The join key is the **trace ID**

All events of a nested flow share the **trace** — the 2nd `-`-segment of
`transactionId` (`00-<trace>-<span>-01/<counter>`). Often the *full*
`transactionId` is identical across the nested journeys too, but not always
(some traces carry up to 15 distinct full IDs), so **trace ID is the robust key**.

Measured on one unfiltered uat run: **3,623 of 7,552 traces span >1 journey**
(some span 8–10).

### 3.5 Why the single-journey report showed no inner trees

Selecting one journey applies a **server-side `treeName` filter**, which drops
every inner journey's events (they have different tree names). So a
`MasterLogin`-only pull contains only `MasterLogin`-tagged events — the
`IJ: …` evaluators appear as leaf nodes with a `true`/`false` outcome, and there
is nothing to nest. **To see inner-tree internals, run unfiltered** (or select
the parent + its inner journeys).

### 3.6 What Ping docs say

- `AM-NODE-LOGIN-COMPLETED` is in the `am-authentication` audit source; one event
  per node completion.
- Journey **debug mode** shows node-by-node state incl. nested trees, but is
  **dev-env only, UI popup, not via `/monitoring/logs`**.
- Script `logger.*()` output goes to the **`am-core`** source and *is* pullable —
  a fallback way to trace inner-tree internals **if** journeys are instrumented
  (not needed given §3.3).
- Docs: [audit logging use case](https://docs.pingidentity.com/pingoneaic/latest/use-cases/use-case-audit-logging.html),
  [log sources](https://docs.pingidentity.com/pingoneaic/tenants/audit-debug-log-sources.html),
  [Inner Tree Evaluator node](https://docs.pingidentity.com/auth-node-ref/latest/auth-node-inner-tree-evaluator.html),
  [Scripted Decision node API](https://docs.pingidentity.com/pingoneaic/am-scripting/scripting-api-node.html).

---

## 4. Inner-tree reconstruction via trace correlation (IMPLEMENTED 2026-06-10)

Spec: `superpowers/specs/2026-06-10-journey-inner-tree-trace-nesting-design.md` · Plan: `superpowers/plans/2026-06-10-journey-inner-tree-trace-nesting.md` (paths relative to `docs/`).

Data-validated approach to render genuine inner-tree nodes nested under their
`IJ:` evaluator, multi-level.

1. **Pull must include inner-journey events** → run unfiltered, or select the
   parent + its inner journeys. (The single-journey filter is what hides them.)
2. **Analyzer (implemented):**
   - Attribute each node to its **own `info.treeName`** (not the open-attempt
     stack). This alone fixes attribution in every case.
   - Correlate events by **trace ID** (2nd segment of `transactionId`).
   - Build parent→child **edges** from `InnerTreeEvaluatorNode`s: parent = the
     evaluator's `treeName`; child = the journey whose nodes ran immediately
     before the evaluator within the trace (use the `IJ: <name>`↔`<name>Main`
     hint as a tiebreaker).
3. **UI:** nest the child journey's real nodes under its `IJ:` evaluator row.

This **superseded and removed** the edge-from-`INITIATED` logic and the
"last-COMPLETED-is-outer" heuristic (both inert on this tenant).

Caveats: traces split across window boundaries (rare; traces are sub-second over
hour-sized windows) won't correlate; evaluator→child mapping is heuristic when
several inner journeys interleave.

---

## 5. Performance

Generation time is **almost entirely the AIC log pull**, not analysis. The pull
pages `am-authentication` sequentially (cookie-based) with a floor delay between
pages.

- Page size is AIC's max (1000); not tunable.
- `time ≈ pages × (latency + requestDelayMs)`. Default `requestDelayMs` = **5000**.
  Example: a 100-page run ≈ 100 × ~5.8s ≈ **9–10 min**, ~85% of it pure delay.
- Concurrency exists only **across windows** (`windowConcurrency`, default 4,
  max 6). A single-window run gets none. `MAX_PAGES` = 200/window.
- Node-level reports are inherently ~20× the volume of Rates-only (node events
  vs. tree-only), so the tuning below matters most there.

### Tuning (no code change)

1. **Lower "Request delay"** (biggest lever) — try 1–2s; the adaptive 429
   governor backs off if AIC throttles.
2. **Use "Window split" to parallelize a single day** — e.g. 24h range with
   split = 4h → 6 windows pulled 6-way concurrent ≈ ~6× faster. Node data still
   flows (it rides in the rollup); only per-attempt rows are dropped.
3. **Select only the journeys you need** (parent + inner) → fewer pages.
4. **Re-analyze retained raw** when iterating on analysis (instant, no re-pull).

### Possible code improvements

- Adaptive per-page delay (start fast, raise only on real 429s).
- One-click "re-analyze from retained raw" for the whole report.
- Sample mode (bounded pull for fast approximate distributions).
- Auto sub-day window fan-out for ≤24h ranges.

---

## 6. Gotchas / lessons

- **Rates only = no node data.** `summaryOnly` uses `SUMMARY_FILTER` which drops
  `AM-NODE-LOGIN-COMPLETED`. The node section shows a hint to re-run with it off.
- **`(unknown)` bucket** = nodes that couldn't be attributed to a tree; if it
  appears, attribution logic (or missing `info.treeName`) is the cause.
- **`IJ:` prefix** in this tenant marks inner-tree evaluator nodes; the
  authoritative signal is `nodeType === "InnerTreeEvaluatorNode"`.
- Single-journey filtering is convenient for **rates** but actively hides
  **inner-tree structure** — opposite needs.
