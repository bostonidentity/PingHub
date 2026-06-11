# Inner-Tree Trace-Correlation Nesting + Inner-Journey Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nest inner journeys' real nodes under their `IJ:` evaluator rows in the Journey History report by correlating events on the trace segment of `transactionId`, and add a config-resolved inner-journey checklist so users can pull a parent journey plus exactly the inner branches they want to dive into.

**Architecture:** Two independent units. Unit 1 (Tasks 1–5) rewires how the analyzer (`journey-history.ts`) computes `nodeStructure` — own-`treeName` node attribution, evaluator-anchored edges from trace-ordered events, trace-based outer-tree detection — with **no change** to the `NodeStructure`/`TreeEdge` shapes, persisted report format, merge logic, or `NodeOutcomeTree` UI. Unit 2 (Tasks 6–9) adds a dep-tree resolver + API route + checklist component whose only output is extra names in `treeNames`. Task 10 updates docs.

**Tech Stack:** TypeScript, Next.js (READ `node_modules/next/dist/docs/` before writing route/component code — this Next version has breaking changes vs. training data), vitest, React client components, Tailwind classes matching the existing panel.

**Spec:** `docs/superpowers/specs/2026-06-10-journey-inner-tree-trace-nesting-design.md`
**Background facts:** `docs/journey-report-node-outcomes.md` §3 (how AIC logs inner trees), §4 (the approach being implemented).

**Working directory for all commands:** `ping-aic-studio/`
**Run tests with:** `npx vitest run src/lib/reports/journey-history.test.ts` (targeted) / `npm test` (full).

**Key domain facts you need (from the docs above):**
- `AM-NODE-LOGIN-COMPLETED` events carry `entries[0].info`: `treeName` (the node's OWN journey — inner journeys log under their own name), `displayName`, `nodeName`, `nodeOutcome`, `nodeType`. `nodeType === "InnerTreeEvaluatorNode"` marks the parent-journey node that invoked an inner tree; it fires AFTER the child's events.
- `transactionId` format: `00-<trace>-<span>-01/<counter>`. Nested journeys in one user flow can carry different full IDs but share `<trace>`.
- Some tenants emit zero `AM-TREE-LOGIN-INITIATED` events; the analyzer reconstructs attempts from `COMPLETED` + buffered nodes. That attempt-level logic is NOT being changed — only node-stat attribution, edges, and outer-tree detection.

---

### Task 1: `traceOf` / `counterOf` helpers

**Files:**
- Modify: `src/lib/reports/journey-history.ts` (add two exported helpers near `classifyEvent`, ~line 152)
- Test: `src/lib/reports/journey-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `journey-history.test.ts` (top-level, after the existing imports — also add `traceOf, counterOf` to the import from `./journey-history`):

```ts
describe("traceOf / counterOf", () => {
    it("extracts the trace segment from a W3C-style transactionId", () => {
        expect(traceOf("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01/5"))
            .toBe("0af7651916cd43dd8448eb211c80319c");
    });
    it("falls back to the full id on unexpected shapes", () => {
        expect(traceOf("t1")).toBe("t1");
        expect(traceOf("")).toBe("");
    });
    it("parses the request counter, defaulting to 0", () => {
        expect(counterOf("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01/12")).toBe(12);
        expect(counterOf("t1")).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: FAIL — `traceOf` is not exported.

- [ ] **Step 3: Implement the helpers**

In `journey-history.ts`, after `classifyEvent`:

```ts
/** Trace segment (2nd `-`-field) of an AIC transactionId
 *  (`00-<trace>-<span>-01/<counter>`). Nested journeys in one user flow can
 *  carry different full transactionIds but always share the trace, so it is
 *  the robust correlation key. Falls back to the full id when the shape
 *  doesn't match (degrades to per-transaction grouping). */
export function traceOf(transactionId: string): string {
    const m = /^[0-9a-f]{1,2}-([0-9a-f]{8,})-[0-9a-f]+-/i.exec(transactionId);
    return m ? m[1] : transactionId;
}

/** Numeric `/<counter>` suffix of a transactionId — secondary sort key for
 *  events sharing a timestamp. 0 when absent/non-numeric. */
export function counterOf(transactionId: string): number {
    const i = transactionId.lastIndexOf("/");
    const n = i >= 0 ? Number(transactionId.slice(i + 1)) : NaN;
    return Number.isFinite(n) ? n : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/journey-history.ts src/lib/reports/journey-history.test.ts
git commit -m "feat(report): trace/counter parsing for trace-ID correlation"
```

---

### Task 2: Attribute node stats to the event's own `treeName`

**Files:**
- Modify: `src/lib/reports/journey-history.ts` (node-completed branch ~line 238, `pendingNodes` ~line 212, synth-COMPLETED ~line 318, leftover loop ~line 365)
- Test: `src/lib/reports/journey-history.test.ts`

- [ ] **Step 1: Add the flexible fixture helper + failing tests**

In `journey-history.test.ts`, next to the existing `nodeVisitN` helper, add (used by all later tasks too):

```ts
/** Node-completed event with full control over the info block (tree/type/etc.). */
function nodeEv(ts: string, txn: string, o: { tree?: string; display: string; name?: string; outcome?: string; type?: string }): RawAuthEvent {
    const info: Record<string, unknown> = { displayName: o.display };
    if (o.tree) info.treeName = o.tree;
    if (o.name) info.nodeName = o.name;
    if (o.outcome !== undefined) info.nodeOutcome = o.outcome;
    if (o.type) info.nodeType = o.type;
    return { timestamp: ts, payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: txn, entries: [{ info }] } };
}
```

Add inside `describe("nodeStructure", ...)`:

```ts
it("attributes nodes to their own treeName even with no COMPLETED at all", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "n3", { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", "n3", { tree: "Inner", display: "Script", outcome: "true" }),
        // window truncated: no COMPLETED events
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.nodes.find((n) => n.displayName === "Page Node")).toMatchObject({ treeName: "Master", visits: 1 });
    expect(r.nodeStructure.nodes.find((n) => n.displayName === "Script")).toMatchObject({ treeName: "Inner", visits: 1 });
    expect(r.nodeStructure.nodes.some((n) => n.treeName === "(unknown)")).toBe(false);
});

it("prefers the event's own treeName over the open attempt's tree", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "t9", "Outer"),
        // A child journey's node logged while Outer is the open attempt:
        nodeEv("2026-06-03T10:00:01Z", "t9", { tree: "Child", display: "Child Step", outcome: "ok" }),
        completed("2026-06-03T10:00:02Z", "t9", "Outer", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.nodes.find((n) => n.displayName === "Child Step")!.treeName).toBe("Child");
});

it("does not double-count buffered nodes that carried their own treeName", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "n4", { tree: "Master", display: "Check", outcome: "ok" }),
        completed("2026-06-03T10:00:02Z", "n4", "Master", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.nodes.find((n) => n.displayName === "Check")!.visits).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: the three new tests FAIL (first: nodes empty/unknown; second: treeName "Outer"; third: visits 2). All pre-existing tests still PASS.

- [ ] **Step 3: Implement own-treeName attribution**

In `journey-history.ts`:

(a) Extend the `pendingNodes` element type (~line 212) with a `counted` flag:

```ts
let pendingNodes: { displayName?: string; nodeName?: string; outcome?: string; ts: string; userId?: string; counted?: boolean }[] = [];
```

(b) Replace the `node-completed` branch (currently ~lines 238–273) with:

```ts
if (kind === "node-completed") {
    const display = str(info?.displayName) ?? str(info?.nodeName) ?? "(unknown)";
    const nodeName = str(info?.nodeName) ?? str(info?.displayName) ?? "(unknown)";
    const outcome = str(info?.nodeOutcome);
    // Per-node outcome stats: prefer the event's OWN treeName — inner journeys
    // log their nodes under their own tree (doc §3.3) — falling back to the
    // currently-executing tree for events that omit it.
    const ownTree = str(info?.treeName);
    const top = stack[stack.length - 1];
    let node: NodeOutcomeStat | undefined;
    if (ownTree) node = recordNode(ownTree, display, nodeName, outcome);
    else if (top) node = recordNode(top.treeName, display, nodeName, outcome);

    if (top) {
        // Failure attribution still follows the open-attempt stack.
        top.lastNodeDisplayName = str(info?.displayName) ?? str(info?.nodeName) ?? top.lastNodeDisplayName;
        top.lastNodeOutcome = outcome ?? top.lastNodeOutcome;
        // userId may only become known mid-flow.
        top.userId = top.userId ?? str(p.userId) ?? str(p.principal);
        // Best-effort evaluator linkage: the first node-completed in the
        // parent right after an inner tree finished is its evaluator.
        if (top.awaitingEvaluatorFor && node) {
            const child = top.awaitingEvaluatorFor;
            node.evaluatorForTree = child;
            const edge = edgeMap.get(`${top.treeName}${SEP}${child}`);
            if (edge) edge.evalNames.set(nodeName, (edge.evalNames.get(nodeName) ?? 0) + 1);
            top.awaitingEvaluatorFor = undefined;
        }
    } else {
        // No open INITIATED attempt — buffer for attempt synthesis. Stats were
        // already recorded above when the event carried its own treeName.
        pendingNodes.push({
            displayName: str(info?.displayName) ?? str(info?.nodeName),
            nodeName: str(info?.nodeName) ?? str(info?.displayName),
            outcome,
            ts,
            userId: str(p.userId) ?? str(p.principal),
            counted: !!ownTree,
        });
    }
    continue;
}
```

(Note: the `awaitingEvaluatorFor` block above is kept verbatim for now; Task 3 deletes it.)

(c) In the synth-COMPLETED block (~line 318) and the leftover loop (~line 365), skip already-counted nodes:

```ts
// synth-COMPLETED:
for (const pn of pendingNodes) {
    if (pn.counted) continue;
    recordNode(synthTree, pn.displayName ?? pn.nodeName ?? "(unknown)", pn.nodeName ?? pn.displayName ?? "(unknown)", pn.outcome);
}
// leftover loop:
for (const pn of pendingNodes) {
    if (pn.counted) continue;
    recordNode(leftoverOwner, pn.displayName ?? pn.nodeName ?? "(unknown)", pn.nodeName ?? pn.displayName ?? "(unknown)", pn.outcome);
}
```

- [ ] **Step 4: Run the full file — all tests pass**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: PASS. (Legacy fixtures without `info.treeName` exercise the unchanged fallback paths.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/journey-history.ts src/lib/reports/journey-history.test.ts
git commit -m "feat(report): attribute node stats to the event's own treeName"
```

---

### Task 3: Evaluator-anchored edge pass (sole edge source)

This task removes ALL existing edge derivation (INITIATED-based at ~line 226, synth-based at ~line 377, the `awaitingEvaluatorFor` heuristic) and replaces it with one trace-ordered pass over node events. Five existing tests are rewritten to match the new contract.

**Files:**
- Modify: `src/lib/reports/journey-history.ts`
- Test: `src/lib/reports/journey-history.test.ts`

- [ ] **Step 1: Write the new failing tests**

Add inside `describe("nodeStructure", ...)`:

```ts
it("builds an edge from an evaluator node event (no INITIATED needed)", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "m1", { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", "m1", { tree: "Kerberos", display: "Script: Kerberos", outcome: "true" }),
        nodeEv("2026-06-03T10:00:03Z", "m1", { tree: "Master", display: "IJ: Kerberos", name: "KerberosEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:04Z", "m1", "Master", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges).toEqual([
        { parent: "Master", child: "Kerberos", invocations: 1, evaluatorNodeName: "KerberosEval" },
    ]);
    expect(r.nodeStructure.nodes.find((n) => n.nodeName === "KerberosEval")!.evaluatorForTree).toBe("Kerberos");
});

it("nests three levels via evaluator events", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "m2", { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", "m2", { tree: "MFAReg", display: "MFA Start", outcome: "true" }),
        nodeEv("2026-06-03T10:00:03Z", "m2", { tree: "Risk", display: "Risk Check", outcome: "low" }),
        nodeEv("2026-06-03T10:00:04Z", "m2", { tree: "MFAReg", display: "IJ: Risk", name: "RiskEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        nodeEv("2026-06-03T10:00:05Z", "m2", { tree: "Master", display: "IJ: MFAReg", name: "MfaEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:06Z", "m2", "Master", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`).sort()).toEqual(["MFAReg>Risk", "Master>MFAReg"]);
});

it("correlates events whose full transactionIds differ but share a trace", () => {
    const trace = "0af7651916cd43dd8448eb211c80319c";
    const txnA = `00-${trace}-aaaaaaaaaaaaaaaa-01/1`;
    const txnB = `00-${trace}-bbbbbbbbbbbbbbbb-01/1`;
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", txnA, { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", txnB, { tree: "Child", display: "Step", outcome: "ok" }),
        nodeEv("2026-06-03T10:00:03Z", txnA, { tree: "Master", display: "IJ: Child", name: "ChildEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:04Z", txnA, "Master", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges).toEqual([
        { parent: "Master", child: "Child", invocations: 1, evaluatorNodeName: "ChildEval" },
    ]);
});

it("uses the IJ name hint to pick among interleaved child trees", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "m3", { tree: "P", display: "Start", outcome: "ok" }),
        nodeEv("2026-06-03T10:00:02Z", "m3", { tree: "X", display: "X Step", outcome: "ok" }),
        nodeEv("2026-06-03T10:00:03Z", "m3", { tree: "Y", display: "Y Step", outcome: "ok" }),
        nodeEv("2026-06-03T10:00:04Z", "m3", { tree: "P", display: "IJ: X", name: "XEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:05Z", "m3", "P", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    // Y is more recent, but the evaluator's display name says X.
    expect(r.nodeStructure.edges).toEqual([
        { parent: "P", child: "X", invocations: 1, evaluatorNodeName: "XEval" },
    ]);
});

it("emits no edge when the child journey's events are not in the pull", () => {
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "m4", { tree: "P", display: "Start", outcome: "ok" }),
        // Child journey not selected → its events are absent; only the evaluator fires:
        nodeEv("2026-06-03T10:00:02Z", "m4", { tree: "P", display: "IJ: Hidden", name: "HiddenEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:03Z", "m4", "P", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges).toEqual([]);
});

it("does not double-count edges on tenants that also emit INITIATED", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "m5", "Login"),
        nodeEv("2026-06-03T10:00:01Z", "m5", { tree: "Login", display: "Start", outcome: "ok" }),
        init("2026-06-03T10:00:02Z", "m5", "MFA-Inner"),
        nodeEv("2026-06-03T10:00:03Z", "m5", { tree: "MFA-Inner", display: "Push", outcome: "Approved" }),
        completed("2026-06-03T10:00:04Z", "m5", "MFA-Inner", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:05Z", "m5", { tree: "Login", display: "IJ: MFA-Inner", name: "MfaEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:06Z", "m5", "Login", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges).toEqual([
        { parent: "Login", child: "MFA-Inner", invocations: 1, evaluatorNodeName: "MfaEval" },
    ]);
});
```

- [ ] **Step 2: Rewrite the five existing tests that relied on INITIATED-derived edges**

These are all in `describe("nodeStructure", ...)`. Replace each test body entirely:

(a) `"records parent→child edges and outerTrees for inner trees, and links the evaluator outcome"`:

```ts
it("records parent→child edges and outerTrees for inner trees, and links the evaluator outcome", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "t3", "Login"),
        nodeEv("2026-06-03T10:00:01Z", "t3", { tree: "Login", display: "User ID Lookup", outcome: "TRUE" }),
        init("2026-06-03T10:00:02Z", "t3", "MFA-Inner"),
        nodeEv("2026-06-03T10:00:03Z", "t3", { tree: "MFA-Inner", display: "Push", outcome: "Approved" }),
        completed("2026-06-03T10:00:04Z", "t3", "MFA-Inner", "SUCCESSFUL"),
        // Parent's InnerTreeEvaluatorNode fires right after the inner tree completes:
        nodeEv("2026-06-03T10:00:05Z", "t3", { tree: "Login", display: "Evaluate MFA", name: "MfaEvaluator", outcome: "Continue", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:06Z", "t3", "Login", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.outerTrees).toEqual(["Login"]);
    expect(r.nodeStructure.edges).toEqual([
        { parent: "Login", child: "MFA-Inner", invocations: 1, evaluatorNodeName: "MfaEvaluator" },
    ]);
    const evalNode = r.nodeStructure.nodes.find((n) => n.nodeName === "MfaEvaluator")!;
    expect(evalNode.evaluatorForTree).toBe("MFA-Inner");
    expect(evalNode.treeName).toBe("Login");
    // The inner tree's own node is attributed to the inner tree.
    const push = r.nodeStructure.nodes.find((n) => n.displayName === "Push")!;
    expect(push.treeName).toBe("MFA-Inner");
});
```

(b) `"handles three levels of nesting (depth is unbounded)"`:

```ts
it("handles three levels of nesting (depth is unbounded)", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "t", "Login"),
        nodeEv("2026-06-03T10:00:01Z", "t", { tree: "Login", display: "Start", outcome: "ok" }),
        init("2026-06-03T10:00:02Z", "t", "A"),
        nodeEv("2026-06-03T10:00:03Z", "t", { tree: "A", display: "A Step", outcome: "ok" }),
        init("2026-06-03T10:00:04Z", "t", "B"),
        nodeEv("2026-06-03T10:00:05Z", "t", { tree: "B", display: "Deep", outcome: "x" }),
        completed("2026-06-03T10:00:06Z", "t", "B", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:07Z", "t", { tree: "A", display: "IJ: B", name: "BEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:08Z", "t", "A", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:09Z", "t", { tree: "Login", display: "IJ: A", name: "AEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:10Z", "t", "Login", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.outerTrees).toEqual(["Login"]);
    const edges = r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`).sort();
    expect(edges).toEqual(["A>B", "Login>A"]);
});
```

(c) `"leaves an edge evaluator-less when no node follows the inner tree"` — the contract inverted; rename and re-expect:

```ts
it("emits no edge when the evaluator node event is absent (edges need node events)", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "t", "Login"),
        init("2026-06-03T10:00:01Z", "t", "Inner"),
        nodeEv("2026-06-03T10:00:02Z", "t", { tree: "Inner", display: "X", outcome: "ok" }),
        completed("2026-06-03T10:00:03Z", "t", "Inner", "SUCCESSFUL"),
        completed("2026-06-03T10:00:04Z", "t", "Login", "SUCCESSFUL"), // no evaluator node event
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.edges).toEqual([]);
});
```

(d) `"yields two edges and one merged node set for a reused inner tree"`:

```ts
it("yields two edges and one merged node set for a reused inner tree", () => {
    const mk = (txn: string, parent: string): RawAuthEvent[] => [
        init("2026-06-03T10:00:00Z", txn, parent),
        init("2026-06-03T10:00:01Z", txn, "Shared"),
        nodeEv("2026-06-03T10:00:02Z", txn, { tree: "Shared", display: "Common", outcome: "ok" }),
        completed("2026-06-03T10:00:03Z", txn, "Shared", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:04Z", txn, { tree: parent, display: "IJ: Shared", name: `${parent}Eval`, outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:05Z", txn, parent, "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory([...mk("a", "Login"), ...mk("b", "Register")]);
    const edges = r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`).sort();
    expect(edges).toEqual(["Login>Shared", "Register>Shared"]);
    const common = r.nodeStructure.nodes.filter((n) => n.displayName === "Common");
    expect(common).toHaveLength(1);
    expect(common[0]).toMatchObject({ treeName: "Shared", visits: 2 });
});
```

(e) `"reconstructs inner-tree nesting when INITIATED is omitted (last COMPLETED is outer)"`:

```ts
it("reconstructs inner-tree nesting when INITIATED is omitted", () => {
    // No INITIATED: inner tree B completes before outer journey A in one txn.
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "x", { tree: "B", display: "B Step", outcome: "ok" }),
        completed("2026-06-03T10:00:02Z", "x", "B", "SUCCESSFUL"),       // inner first
        nodeEv("2026-06-03T10:00:03Z", "x", { tree: "A", display: "A Eval", name: "AEval", outcome: "Continue", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:04Z", "x", "A", "SUCCESSFUL"),       // outer last
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.outerTrees).toEqual(["A"]);
    expect(r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`)).toEqual(["A>B"]);
    expect(r.attempts.find((a) => a.treeName === "B")!).toMatchObject({ isInner: true, outerTreeName: "A" });
    expect(r.attempts.find((a) => a.treeName === "A")!).toMatchObject({ isInner: false });
});
```

(f) `"produces empty nodes (but can still see edges) when no node events are present"` — rename and re-expect:

```ts
it("emits no edges in rates-only style event sets (edges require node events)", () => {
    const events: RawAuthEvent[] = [
        init("2026-06-03T10:00:00Z", "t", "Login"),
        init("2026-06-03T10:00:01Z", "t", "Inner"),
        completed("2026-06-03T10:00:02Z", "t", "Inner", "SUCCESSFUL"),
        completed("2026-06-03T10:00:03Z", "t", "Login", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.nodes).toEqual([]);
    expect(r.nodeStructure.edges).toEqual([]);
});
```

Also rewrite the `mergeRollup` sub-describe fixture (it asserted INITIATED-derived edges) — Task 5 owns that; for now, in `"sums node visits/outcomes and edge invocations, unions outerTrees"`, add an evaluator event to each window so it keeps passing. Replace both window fixtures:

```ts
const w1 = analyzeJourneyHistory([
    init("2026-06-03T10:00:00Z", "a", "Login"),
    nodeEv("2026-06-03T10:00:01Z", "a", { tree: "Login", display: "Lookup", outcome: "TRUE" }),
    init("2026-06-03T10:00:02Z", "a", "Inner"),
    nodeEv("2026-06-03T10:00:03Z", "a", { tree: "Inner", display: "Deep", outcome: "ok" }),
    completed("2026-06-03T10:00:04Z", "a", "Inner", "SUCCESSFUL"),
    nodeEv("2026-06-03T10:00:05Z", "a", { tree: "Login", display: "IJ: Inner", name: "InnerEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
    completed("2026-06-03T10:00:06Z", "a", "Login", "SUCCESSFUL"),
]);
const w2 = analyzeJourneyHistory([
    init("2026-06-03T11:00:00Z", "b", "Login"),
    nodeEv("2026-06-03T11:00:01Z", "b", { tree: "Login", display: "Lookup", outcome: "FALSE" }),
    init("2026-06-03T11:00:02Z", "b", "Inner"),
    nodeEv("2026-06-03T11:00:03Z", "b", { tree: "Inner", display: "Deep", outcome: "ok" }),
    completed("2026-06-03T11:00:04Z", "b", "Inner", "SUCCESSFUL"),
    nodeEv("2026-06-03T11:00:05Z", "b", { tree: "Login", display: "IJ: Inner", name: "InnerEval", outcome: "true", type: "InnerTreeEvaluatorNode" }),
    completed("2026-06-03T11:00:06Z", "b", "Login", "SUCCESSFUL"),
]);
```

and change the edge expectation in that test to:

```ts
expect(ns.edges).toEqual([{ parent: "Login", child: "Inner", invocations: 2, evaluatorNodeName: "InnerEval" }]);
```

- [ ] **Step 3: Run tests — new ones fail, rewritten ones fail (old impl still emits INITIATED edges / lacks the evaluator pass)**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: FAIL on the new + rewritten tests.

- [ ] **Step 4: Implement the edge pass and remove the old derivations**

In `journey-history.ts`:

(a) Add a per-trace event collection. Define near the `EdgeAcc` interface:

```ts
/** Minimal per-event record for the trace-ordered edge/outer pass. */
interface TraceEv {
    ts: string;
    counter: number;
    kind: "tree-init" | "tree-completed" | "node-completed";
    treeName?: string;
    nodeName: string;
    displayName: string;
    isEvaluator: boolean;
}
```

(b) In the grouping loop (step "1." in the function, ~lines 167–176), build `byTrace` alongside `byTxn`. After the `byTxn.get(txn)!.push(...)` line:

```ts
const byTrace = new Map<string, TraceEv[]>();   // declare next to byTxn
// ... inside the loop, after pushing to byTxn:
const ginfo = entryInfo(p);
const tr = traceOf(txn);
if (!byTrace.has(tr)) byTrace.set(tr, []);
byTrace.get(tr)!.push({
    ts: ev.timestamp,
    counter: counterOf(txn),
    kind: classifyEvent(p) as TraceEv["kind"],
    treeName: str(ginfo?.treeName) ?? str(p.treeName),
    nodeName: str(ginfo?.nodeName) ?? str(ginfo?.displayName) ?? "(unknown)",
    displayName: str(ginfo?.displayName) ?? str(ginfo?.nodeName) ?? "(unknown)",
    isEvaluator: ginfo?.nodeType === "InnerTreeEvaluatorNode",
});
```

(c) Remove the INITIATED edge derivation: in the `tree-init` branch, change

```ts
const parent = stack[stack.length - 1];
if (parent) recordEdge(parent.treeName, treeName); // inner-tree nesting
else outerSet.add(treeName);                       // entrypoint journey
```

to

```ts
if (stack.length === 0) outerSet.add(treeName);    // entrypoint journey (replaced by trace rule in a later commit)
```

(d) Remove the `awaitingEvaluatorFor` heuristic entirely: delete the field from `OpenAttempt` (~line 122), delete the `if (top.awaitingEvaluatorFor && node) {...}` block added in Task 2, and delete the block in `tree-completed` (~lines 328–331):

```ts
if (!open.isOuter) {
    const parent = stack[stack.length - 1];
    if (parent) parent.awaitingEvaluatorFor = open.treeName;
}
```

(e) Remove the synth edge derivation: in the end-of-transaction synth block (~line 377), delete

```ts
if (inner.tree !== outer.tree) recordEdge(outer.tree, inner.tree);
```

(keep the `isInner`/`outerTreeName` reassignment and `outerSet.add(outer.tree)` — attempt-level and outer logic are unchanged until Task 4).

(f) Add the trace-ordered evaluator pass after the per-transaction loop (after step "3.", before step "4." per-journey rollup):

```ts
// 3b. Evaluator-anchored edge pass: order each trace's node events and emit one
// edge per InnerTreeEvaluatorNode event. The child journey's events run
// immediately before their evaluator within the trace (doc §3.3), so the
// contiguous run of foreign-tree events just before it identifies the child.
for (const evs of byTrace.values()) {
    evs.sort((a, b) => a.ts.localeCompare(b.ts) || a.counter - b.counter);
    const nodeEvs = evs.filter((e) => e.kind === "node-completed" && e.treeName);
    for (let i = 0; i < nodeEvs.length; i++) {
        const ev = nodeEvs[i];
        if (!ev.isEvaluator) continue;
        const parent = ev.treeName!;
        const candidates: string[] = []; // most recent first
        for (let j = i - 1; j >= 0; j--) {
            const t = nodeEvs[j].treeName!;
            if (t === parent) break;
            if (!candidates.includes(t)) candidates.push(t);
        }
        if (candidates.length === 0) continue; // child not selected / outside window → IJ row stays a leaf
        const child = pickEdgeChild(candidates, ev.displayName);
        const edge = recordEdge(parent, child);
        edge.evalNames.set(ev.nodeName, (edge.evalNames.get(ev.nodeName) ?? 0) + 1);
        const stat = nodeMap.get(`${parent}${SEP}${ev.nodeName}`);
        if (stat) stat.evaluatorForTree = child;
    }
}
```

(g) Add the tiebreak helper next to `mostCommon`:

```ts
/** Choose the evaluator's child tree from candidate trees (most recent first),
 *  preferring one whose name contains the display-name hint ("IJ: MFA" → "MFA")
 *  when interleaved children make the recency answer ambiguous. */
function pickEdgeChild(candidates: string[], evaluatorDisplay: string): string {
    if (candidates.length > 1) {
        const hint = evaluatorDisplay.replace(/^IJ:?\s*/i, "").trim().toLowerCase();
        if (hint) {
            const hit = candidates.find((c) => c.toLowerCase().includes(hint));
            if (hit) return hit;
        }
    }
    return candidates[0];
}
```

- [ ] **Step 5: Run the full file**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: PASS — every test, new and rewritten. If an attempt-level test (first `describe`) fails, you broke the stack/synth logic: re-check that only `recordEdge` calls, `awaitingEvaluatorFor`, and nothing else was removed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/journey-history.ts src/lib/reports/journey-history.test.ts
git commit -m "feat(report): trace-correlated evaluator-anchored inner-tree edges"
```

---

### Task 4: Trace-based outer-tree detection

**Files:**
- Modify: `src/lib/reports/journey-history.ts`
- Test: `src/lib/reports/journey-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe("nodeStructure", ...)`:

```ts
it("does not list a pulled-along inner journey as a root, even across differing txn ids", () => {
    const trace = "1bf7651916cd43dd8448eb211c80319c";
    const txnA = `00-${trace}-aaaaaaaaaaaaaaaa-01/1`;
    const txnB = `00-${trace}-bbbbbbbbbbbbbbbb-01/1`;
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", txnA, { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", txnB, { tree: "Inner", display: "Step", outcome: "ok" }),
        completed("2026-06-03T10:00:03Z", txnB, "Inner", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:04Z", txnA, { tree: "Master", display: "IJ: Inner", name: "E", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:05Z", txnA, "Master", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.outerTrees).toEqual(["Master"]);
});

it("keeps a journey a root when it also runs standalone in another trace", () => {
    const events: RawAuthEvent[] = [
        // Trace 1: Inner runs nested under Master.
        nodeEv("2026-06-03T10:00:01Z", "tr1", { tree: "Master", display: "Page Node", outcome: "true" }),
        nodeEv("2026-06-03T10:00:02Z", "tr1", { tree: "Inner", display: "Step", outcome: "ok" }),
        nodeEv("2026-06-03T10:00:03Z", "tr1", { tree: "Master", display: "IJ: Inner", name: "E", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:04Z", "tr1", "Master", "SUCCESSFUL"),
        // Trace 2: Inner runs standalone.
        nodeEv("2026-06-03T11:00:01Z", "tr2", { tree: "Inner", display: "Step", outcome: "ok" }),
        completed("2026-06-03T11:00:02Z", "tr2", "Inner", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect([...r.nodeStructure.outerTrees].sort()).toEqual(["Inner", "Master"]);
});

it("treats the outer journey as root when its first node IS the evaluator (INITIATED-less)", () => {
    // Child events precede ALL parent events; last COMPLETED still identifies the outer.
    const events: RawAuthEvent[] = [
        nodeEv("2026-06-03T10:00:01Z", "tx", { tree: "Child", display: "Step", outcome: "ok" }),
        completed("2026-06-03T10:00:02Z", "tx", "Child", "SUCCESSFUL"),
        nodeEv("2026-06-03T10:00:03Z", "tx", { tree: "Parent", display: "IJ: Child", name: "E", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T10:00:04Z", "tx", "Parent", "SUCCESSFUL"),
    ];
    const r = analyzeJourneyHistory(events);
    expect(r.nodeStructure.outerTrees).toEqual(["Parent"]);
});
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: first new test FAILS (old per-txn synth logic adds "Inner" as outer because it completes its own txn). The other two may pass by accident — keep them as regression guards.

- [ ] **Step 3: Implement the per-trace outer rule**

In `journey-history.ts`:

(a) Remove the remaining `outerSet` writes in the per-transaction walk:
- in `tree-init`: delete `if (stack.length === 0) outerSet.add(treeName);` (keep the rest of the branch)
- in the synth end-of-transaction block: delete `outerSet.add(outer.tree);` (keep the `isInner`/`outerTreeName` reassignment loop)

(b) In the trace pass added in Task 3 (3b), compute outer per trace. Insert at the top of the `for (const evs of byTrace.values())` loop body, right after the `evs.sort(...)` line:

```ts
// Outer tree per trace (spec "Outer trees"): first INITIATED if the tenant
// emits them (exact); else the LAST tree-completed (inner trees complete
// before their parent); else first event with a treeName (window-truncated
// traces, best effort).
const firstInit = evs.find((e) => e.kind === "tree-init" && e.treeName);
let lastCompleted: TraceEv | undefined;
for (const e of evs) if (e.kind === "tree-completed" && e.treeName) lastCompleted = e;
const firstNamed = evs.find((e) => e.treeName);
const outer = firstInit?.treeName ?? lastCompleted?.treeName ?? firstNamed?.treeName;
if (outer) outerSet.add(outer);
```

- [ ] **Step 4: Run the full file**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: PASS — including all pre-existing outer-tree expectations (`["Login"]`, `["MasterLogin"]`, `["A"]` tests: rule 1 covers INITIATED fixtures, rule 2 covers INITIATED-less ones).

- [ ] **Step 5: Run the whole suite (analyzer is used by runner/routes)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/journey-history.ts src/lib/reports/journey-history.test.ts
git commit -m "feat(report): per-trace outer-tree detection"
```

---

### Task 5: Windowed-merge regression test for trace-derived edges

`mergeNodeStructure` is intentionally unchanged; this pins that trace-derived edges survive the windowed merge. The fixture was already updated in Task 3 — this task adds the cross-window-trace caveat test.

**Files:**
- Test: `src/lib/reports/journey-history.test.ts` (inside `describe("mergeRollup folds nodeStructure", ...)`)

- [ ] **Step 1: Write the test (expected to pass — it documents the window-split caveat)**

```ts
it("does not correlate a trace split across two windows (documented limitation)", () => {
    const trace = "2cf7651916cd43dd8448eb211c80319c";
    const txn = `00-${trace}-aaaaaaaaaaaaaaaa-01/1`;
    // Window 1 ends after the child's events; window 2 has only the evaluator.
    const w1 = analyzeJourneyHistory([
        nodeEv("2026-06-03T10:59:58Z", txn, { tree: "Child", display: "Step", outcome: "ok" }),
    ]);
    const w2 = analyzeJourneyHistory([
        nodeEv("2026-06-03T11:00:01Z", txn, { tree: "Master", display: "IJ: Child", name: "E", outcome: "true", type: "InnerTreeEvaluatorNode" }),
        completed("2026-06-03T11:00:02Z", txn, "Master", "SUCCESSFUL"),
    ]);
    const merged = mergeRollup(mergeRollup(emptyRollup(), w1), w2);
    // No edge: each window saw only half the trace. Node stats still both present.
    expect(merged.nodeStructure!.edges).toEqual([]);
    expect(merged.nodeStructure!.nodes.map((n) => n.treeName).sort()).toEqual(["Child", "Master"]);
});
```

- [ ] **Step 2: Run, expect PASS; commit**

Run: `npx vitest run src/lib/reports/journey-history.test.ts`
Expected: PASS.

```bash
git add src/lib/reports/journey-history.test.ts
git commit -m "test(report): pin window-split trace caveat for edge merging"
```

---

### Task 6: `resolveJourneyDepTree` + `flattenDepTree`

**Files:**
- Modify: `src/lib/resolve-journey-deps.ts`
- Test: `src/lib/resolve-journey-deps.test.ts` (reuse its existing `tempDir`/`writeJson`/`writeJourneyNode` helpers — they write under `<dir>/alpha/journeys/...`)

- [ ] **Step 1: Write the failing tests**

Append to `resolve-journey-deps.test.ts` (extend the import line to include `resolveJourneyDepTree, flattenDepTree`):

```ts
describe("resolveJourneyDepTree", () => {
    it("builds a nested tree for a 3-level closure", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Master", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "MFA" });
        writeJourneyNode(dir, "MFA", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Risk" });
        writeJourneyNode(dir, "Risk", "page.json", { _type: { _id: "PageNode" } });
        const tree = resolveJourneyDepTree(dir, "Master");
        expect(tree).toEqual({
            name: "Master",
            children: [{ name: "MFA", children: [{ name: "Risk", children: [] }] }],
        });
        expect(flattenDepTree(tree)).toEqual(["MFA", "Risk"]);
    });

    it("marks config cycles as repeated and stops expanding", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "A", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "B" });
        writeJourneyNode(dir, "B", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "A" });
        const tree = resolveJourneyDepTree(dir, "A");
        expect(tree.children).toEqual([
            { name: "B", children: [{ name: "A", children: [], repeated: true }] },
        ]);
        // The root journey never appears in the flat closure, repeated or not.
        expect(flattenDepTree(tree)).toEqual(["B"]);
    });

    it("marks journeys missing from config", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Login", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Ghost" });
        const tree = resolveJourneyDepTree(dir, "Login");
        expect(tree.children).toEqual([{ name: "Ghost", children: [], missing: true }]);
        expect(flattenDepTree(tree)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/resolve-journey-deps.test.ts`
Expected: FAIL — `resolveJourneyDepTree` is not exported.

- [ ] **Step 3: Implement in `resolve-journey-deps.ts`**

Append:

```ts
export interface JourneyDepNode {
  /** Journey name. */
  name: string;
  children: JourneyDepNode[];
  /** Referenced by an InnerTreeEvaluatorNode but not found in config. */
  missing?: true;
  /** Already expanded elsewhere in this tree; children omitted (cycle guard). */
  repeated?: true;
}

/**
 * Resolve a journey's inner-journey closure from pulled config as a tree:
 * children are the trees referenced by the journey's InnerTreeEvaluatorNodes,
 * recursively. A journey reached a second time anywhere in the tree is marked
 * `repeated` and not re-expanded.
 */
export function resolveJourneyDepTree(configDir: string, journeyName: string): JourneyDepNode {
  const expanded = new Set<string>();
  const build = (name: string): JourneyDepNode => {
    if (expanded.has(name)) return { name, children: [], repeated: true };
    expanded.add(name);
    const realmRoots = getRealmRoots(configDir, path.join("journeys", name, "nodes"));
    if (realmRoots.length === 0) return { name, children: [], missing: true };
    const childNames = new Set<string>();
    for (const realmRoot of realmRoots) {
      const nodesDir = path.join(realmRoot, "journeys", name, "nodes");
      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as { tree?: string; _type?: { _id?: string } };
          if (nd._type?._id === "InnerTreeEvaluatorNode" && nd.tree) childNames.add(nd.tree);
        } catch { /* skip unparseable node file */ }
      }
    }
    return { name, children: [...childNames].sort((a, b) => a.localeCompare(b)).map(build) };
  };
  return build(journeyName);
}

/** De-duped, sorted closure names from a dep tree. Excludes the root journey
 *  and `missing` entries — directly usable as additional report treeNames. */
export function flattenDepTree(root: JourneyDepNode): string[] {
  const out = new Set<string>();
  const walk = (n: JourneyDepNode) => {
    if (!n.missing && n.name !== root.name) out.add(n.name);
    for (const c of n.children) walk(c);
  };
  for (const c of root.children) walk(c);
  return [...out].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `npx vitest run src/lib/resolve-journey-deps.test.ts`
Expected: PASS (including the pre-existing `resolveJourneyDeps` tests).

```bash
git add src/lib/resolve-journey-deps.ts src/lib/resolve-journey-deps.test.ts
git commit -m "feat(deps): resolve a journey's inner-journey closure as a tree"
```

---

### Task 7: `GET /api/analyze/journey-deps` route

**Files:**
- Create: `src/app/api/analyze/journey-deps/route.ts`

Pattern-match `src/app/api/analyze/journeys/route.ts` (same env validation). Before writing, skim `node_modules/next/dist/docs/` route-handler docs per AGENTS.md.

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getEnvironments, getConfigDir } from "@/lib/fr-config";
import { resolveJourneyDepTree, flattenDepTree } from "@/lib/resolve-journey-deps";

export const dynamic = "force-dynamic";

/** GET /api/analyze/journey-deps?env=prod&journey=MasterLogin
 *  → { tree: JourneyDepNode, flat: string[] } — the journey's inner-journey
 *  closure from pulled config, for the report's inner-journey picker. */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  const journey = req.nextUrl.searchParams.get("journey") ?? "";
  if (!env || !getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  if (!journey) {
    return NextResponse.json({ error: "journey is required" }, { status: 400 });
  }
  const configDir = getConfigDir(env);
  if (!configDir) {
    return NextResponse.json({ error: "no pulled config for environment" }, { status: 404 });
  }
  const tree = resolveJourneyDepTree(configDir, journey);
  if (tree.missing) {
    return NextResponse.json({ error: "journey not found in config" }, { status: 404 });
  }
  return NextResponse.json({ tree, flat: flattenDepTree(tree) });
}
```

If `getConfigDir` is not exported from `@/lib/fr-config`, check how `src/lib/journey-list.ts` imports it (it uses `getConfigDir` from `./fr-config`) and mirror that.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke test (only if a dev env with pulled config is at hand — otherwise skip; the picker task re-verifies end-to-end)**

Run: `curl -s "http://localhost:3000/api/analyze/journey-deps?env=<env>&journey=<name>"` against `npm run dev`.
Expected: `{"tree":{...},"flat":[...]}`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/analyze/journey-deps/route.ts
git commit -m "feat(api): journey inner-dependency closure endpoint"
```

---

### Task 8: `JourneyDepPicker` component

**Files:**
- Create: `src/app/analyze/JourneyDepPicker.tsx`

Styling matches the panel (Tailwind, slate/sky palette, `text-xs` controls).

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";

export interface JourneyDepNode {
    name: string;
    children: JourneyDepNode[];
    missing?: true;
    repeated?: true;
}

/** Selectable (non-missing) names in a dep tree, excluding the root journey. */
function selectableNames(root: JourneyDepNode): string[] {
    const out = new Set<string>();
    const walk = (n: JourneyDepNode) => {
        if (!n.missing && n.name !== root.name) out.add(n.name);
        for (const c of n.children) walk(c);
    };
    for (const c of root.children) walk(c);
    return [...out];
}

function DepRow({ node, root, depth, checked, onToggle }: {
    node: JourneyDepNode; root: string; depth: number; checked: Set<string>; onToggle: (name: string) => void;
}) {
    const selectable = !node.missing && node.name !== root;
    return (
        <>
            <label
                className={`flex items-center gap-2 text-xs ${node.missing ? "text-slate-400" : "text-slate-700"}`}
                style={{ paddingLeft: depth * 16 }}
            >
                <input
                    type="checkbox"
                    className="accent-sky-600"
                    disabled={!selectable}
                    checked={checked.has(node.name)}
                    onChange={() => onToggle(node.name)}
                />
                <span>
                    {node.name}
                    {node.missing ? " (not in config)" : node.repeated ? " (repeated)" : ""}
                </span>
            </label>
            {node.children.map((c) => (
                <DepRow key={`${node.name}>${c.name}`} node={c} root={root} depth={depth + 1} checked={checked} onToggle={onToggle} />
            ))}
        </>
    );
}

/**
 * Inner-journey checklist for the Journey History report. For each selected
 * journey, shows its inner-journey closure (resolved from pulled config) as an
 * indented checkbox tree. Checked names are pulled along with the parents —
 * a journey filter otherwise hides inner journeys' events, because inner trees
 * log under their own treeName (docs/journey-report-node-outcomes.md §3.5).
 */
export function JourneyDepPicker({ env, parents, checked, onChange }: {
    env: string;
    parents: string[];
    checked: string[];
    onChange: (next: string[]) => void;
}) {
    // parent journey → its dep tree (null while loading/failed). Reset per env.
    const [trees, setTrees] = useState<Record<string, JourneyDepNode | null>>({});
    useEffect(() => { setTrees({}); }, [env]);

    useEffect(() => {
        let cancelled = false;
        for (const parent of parents) {
            if (parent in trees) continue;
            setTrees((t) => ({ ...t, [parent]: null }));
            fetch(`/api/analyze/journey-deps?env=${encodeURIComponent(env)}&journey=${encodeURIComponent(parent)}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d: { tree: JourneyDepNode } | null) => {
                    if (!cancelled && d?.tree) setTrees((t) => ({ ...t, [parent]: d.tree }));
                })
                .catch(() => { /* tree stays null — section simply doesn't render */ });
        }
        return () => { cancelled = true; };
    }, [env, parents, trees]);

    const checkedSet = useMemo(() => new Set(checked), [checked]);
    const allowed = useMemo(() => {
        const out = new Set<string>();
        for (const parent of parents) {
            const tree = trees[parent];
            if (tree) for (const n of selectableNames(tree)) out.add(n);
        }
        return out;
    }, [parents, trees]);

    // Drop checked entries whose parent journey was deselected.
    useEffect(() => {
        const pruned = checked.filter((c) => allowed.has(c));
        if (pruned.length !== checked.length) onChange(pruned);
    }, [allowed, checked, onChange]);

    const toggle = (name: string) => {
        onChange(checkedSet.has(name) ? checked.filter((c) => c !== name) : [...checked, name]);
    };

    const sections = parents.filter((parent) => (trees[parent]?.children.length ?? 0) > 0);
    if (sections.length === 0) return null;

    return (
        <div className="space-y-2 rounded border border-slate-200 bg-white px-3 py-2">
            {sections.map((parent) => {
                const tree = trees[parent]!;
                const names = selectableNames(tree);
                const allOn = names.length > 0 && names.every((n) => checkedSet.has(n));
                return (
                    <div key={parent} className="space-y-1">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-600">Inner journeys of {parent}</span>
                            <button
                                type="button"
                                className="text-[11px] text-sky-700 hover:underline"
                                onClick={() => onChange(allOn
                                    ? checked.filter((c) => !names.includes(c))
                                    : [...new Set([...checked, ...names])])}
                            >
                                {allOn ? "Clear" : "Select all"}
                            </button>
                        </div>
                        {tree.children.map((c) => (
                            <DepRow key={`${parent}>${c.name}`} node={c} root={parent} depth={0} checked={checkedSet} onToggle={toggle} />
                        ))}
                    </div>
                );
            })}
            <p className="text-[11px] text-slate-500">
                Checked inner journeys are pulled with the report so their nodes can nest under the parent&apos;s evaluator rows.
            </p>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/analyze/JourneyDepPicker.tsx
git commit -m "feat(report): inner-journey checklist component"
```

---

### Task 9: Panel integration (state, union, >25 warning)

**Files:**
- Modify: `src/app/analyze/JourneyHistoryPanel.tsx`

- [ ] **Step 1: Wire the state**

(a) Add imports at the top of the file with the other local/lib imports:

```ts
import { JourneyDepPicker } from "./JourneyDepPicker";
import { MAX_SERVER_FILTER_JOURNEYS } from "@/lib/reports/journey-filter";
```

(b) After the `selectedJourneys` state (line ~216), add (deliberately NOT in `SavedSettings`/localStorage — checklist state is ephemeral per spec):

```ts
// Inner journeys (from the dep picker) pulled along with the selected parents.
const [innerChecked, setInnerChecked] = useState<string[]>([]);
```

(c) In the env-change effect (~line 324), reset it alongside the journey selection:

```ts
if (didInitEnv.current) { setSelectedJourneys([]); setInnerChecked([]); }
```

(d) Below the state declarations, add the union used by every run path:

```ts
const runTreeNames = useMemo(
    () => [...new Set([...selectedJourneys, ...innerChecked])],
    [selectedJourneys, innerChecked],
);
```

- [ ] **Step 2: Use the union in every run path**

Run: `grep -n "treeNames: selectedJourneys" src/app/analyze/JourneyHistoryPanel.tsx`
Replace EVERY hit (the live `run()` at ~line 355 and the archive path) with:

```ts
treeNames: runTreeNames,
```

- [ ] **Step 3: Render the picker and the >25 warning**

After the `JourneyMultiSelect` block (~lines 725–732), add:

```tsx
{journeySource === "config" && selectedJourneys.length > 0 ? (
    <JourneyDepPicker env={env} parents={selectedJourneys} checked={innerChecked} onChange={setInnerChecked} />
) : null}
{runTreeNames.length > MAX_SERVER_FILTER_JOURNEYS ? (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {runTreeNames.length} journeys selected — above {MAX_SERVER_FILTER_JOURNEYS}, the run pulls all
        journeys and filters locally, which is much slower. Consider narrowing the selection.
    </div>
) : null}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npm test` — expected: PASS.
If a dev environment with pulled config is available: `npm run dev`, open the Report tab, select a journey with inner journeys, confirm the checklist appears, check a branch, run a non-rates-only report, and confirm the inner journey nests under its `IJ:` row in Node outcomes. Otherwise note in the commit body that UI was typecheck-verified only.

- [ ] **Step 5: Commit**

```bash
git add src/app/analyze/JourneyHistoryPanel.tsx
git commit -m "feat(report): pull checked inner journeys with the report run"
```

---

### Task 10: Documentation + final verification

**Files:**
- Modify: `docs/journey-report-node-outcomes.md`

- [ ] **Step 1: Update the reference doc**

In `docs/journey-report-node-outcomes.md`:
- §1 status table: set "Inner-tree nesting via parent/child **edges**" to "**Removed** — superseded by trace correlation (2026-06-10)"; set "Inner-tree nesting via **trace correlation**" to "**Implemented (2026-06-10)**"; add a row "Inner-journey picker (config-resolved closure checklist) | **Implemented (2026-06-10)**".
- Delete the stale line "Not committed to git yet as of this writing — changes live in the working tree."
- §4 heading: change "(PROPOSED)" to "(IMPLEMENTED 2026-06-10)" and add a pointer to the spec + plan files.

- [ ] **Step 2: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/journey-report-node-outcomes.md
git commit -m "docs(report): mark trace-correlation nesting + dep picker implemented"
```

- [ ] **Step 4: Manual validation against retained raw (requires the uat dataset)**

Re-analyze a retained-raw uat report (Inspect → re-analyze, or re-run from archive source) and confirm `kyid_2B1_MasterLogin` shows `IJ: Kerberos` / `IJ: PTAJIT` / MFA chains with the children's real nodes nested beneath, matching the known trace in `docs/journey-report-node-outcomes.md` §3.3. Record the result (pass/anomalies) in the final report to the user.

---

## Self-review notes (already applied)

- **Spec coverage:** trace key → T1; own-treeName attribution → T2; evaluator edge pass + sole-source + tiebreak + evaluatorForTree → T3; outer-tree rule (as amended in the spec) → T4; merge/window caveat → T5; dep tree lib → T6; API → T7; checklist UI (unchecked default, select-all, missing greyed, repeated) → T8; treeNames union + ephemeral state + >25 warning → T9; docs → T10. Error-handling table: traceOf fallback (T1), no-candidates → no edge (T3), window split (T5), missing/cycle (T6/T8), rates-only hint already exists (unchanged).
- **Type consistency:** `TraceEv`, `pickEdgeChild`, `JourneyDepNode`, `flattenDepTree`, `runTreeNames`, `nodeEv` are each defined before/where used; `JourneyDepNode` is declared in both the lib (server) and component (client) — duplicated intentionally to keep the client bundle free of `fs`-importing modules.
- **Known accepted behavior:** with INITIATED-emitting fixtures where node events DON'T carry `treeName` (legacy first-describe tests), node stats still attribute via the stack — unchanged; those fixtures produce no edges, which no remaining test contradicts.
