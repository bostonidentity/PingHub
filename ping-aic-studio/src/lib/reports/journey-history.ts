/**
 * Journey execution history analyzer.
 *
 * Consumes raw `am-authentication` log payloads (shape that AIC returns from
 * `/monitoring/logs`) and produces per-attempt and per-journey rollups,
 * including inner journeys (InnerTreeEvaluatorNode invocations).
 *
 * AIC emits three relevant `eventName`s per attempt:
 *   - AM-TREE-LOGIN-INITIATED   — journey started
 *   - AM-TREE-LOGIN-COMPLETED   — journey ended; payload.result = "SUCCESSFUL"|"FAILED"
 *   - AM-NODE-LOGIN-COMPLETED   — per-node visit (last one before a failed
 *                                  COMPLETED is the failure node)
 *
 * Inner journeys share the parent transactionId but get their own
 * INITIATED/COMPLETED pair. We pair them with a per-transactionId LIFO stack
 * on (treeName, startedAt) so nested calls match correctly.
 *
 * AM-TREE-LOGIN-INITIATED is OPTIONAL: some tenants don't emit it. When a
 * COMPLETED arrives with no open INITIATED to pair with, we reconstruct the
 * attempt from the COMPLETED itself plus the node visits buffered since the
 * previous COMPLETED in the same transaction.
 */

export interface RawAuthEvent {
    /** ISO timestamp. */
    timestamp: string;
    payload: Record<string, unknown> | string;
}

export interface JourneyAttempt {
    transactionId: string;
    treeName: string;
    /** True when this attempt is an inner-tree invocation, not the entrypoint. */
    isInner: boolean;
    /** The outermost (entrypoint) journey for this transactionId. */
    outerTreeName: string;
    realm?: string;
    userId?: string;
    startedAt: string;
    completedAt?: string;
    outcome: "success" | "fail" | "incomplete";
    /** Display name of the last node visited before a failed COMPLETED. */
    failureNode?: string;
    /** Outcome on the failure node, e.g. "Failure", "FALSE", "Locked". */
    failureNodeOutcome?: string;
}

export interface PerJourneyStat {
    treeName: string;
    /** True when this journey only ever appears as an inner tree. */
    innerOnly: boolean;
    attempts: number;
    success: number;
    fail: number;
    incomplete: number;
    failRate: number;
    /** Top failure nodes by count for this journey. */
    topFailureNodes: { node: string; count: number }[];
}

/** Outcome distribution for one node instance (keyed by treeName + nodeName). */
export interface NodeOutcomeStat {
    treeName: string;
    nodeName: string;
    displayName: string;
    /** Total AM-NODE-LOGIN-COMPLETED hits for this node. */
    visits: number;
    /** outcome value -> count. Visits with no nodeOutcome bucket under "(none)". */
    outcomes: Record<string, number>;
    /** Best-effort: set when this node is the evaluator that invoked the named
     *  inner tree. Such nodes render as the inner-tree row, not a standalone node. */
    evaluatorForTree?: string;
}

/** One observed parent-tree → child-tree nesting relationship, aggregated. */
export interface TreeEdge {
    parent: string;
    child: string;
    invocations: number;
    /** Best-effort evaluator node (by nodeName) in the parent for this edge. */
    evaluatorNodeName?: string;
}

/** Flat aggregates from which the UI composes the journey/node tree. */
export interface NodeStructure {
    /** Trees seen as entrypoint (tree roots). */
    outerTrees: string[];
    /** parent → child nesting. */
    edges: TreeEdge[];
    /** Per-node outcome stats (leaves), sorted by visits desc. */
    nodes: NodeOutcomeStat[];
}

export interface JourneyHistoryReport {
    summary: {
        eventsProcessed: number;
        attempts: number;
        success: number;
        fail: number;
        incomplete: number;
        /** Distinct transactionIds (i.e. distinct end-user attempts). */
        transactions: number;
    };
    attempts: JourneyAttempt[];
    perJourney: PerJourneyStat[];
    /** Journey/node hierarchy + per-node outcome distributions. */
    nodeStructure: NodeStructure;
    /** Set when AIC paging stopped because we hit a cap, so the user knows. */
    truncated?: boolean;
}

interface OpenAttempt {
    treeName: string;
    startedAt: string;
    realm?: string;
    userId?: string;
    lastNodeDisplayName?: string;
    lastNodeOutcome?: string;
    isOuter: boolean;
    /** Set when an inner tree just completed under this attempt: the next
     *  node-completed here is its best-effort evaluator. */
    awaitingEvaluatorFor?: string;
}

/** NUL key separator — safe against names containing spaces/punctuation. */
const SEP = String.fromCharCode(0);

interface EdgeAcc {
    parent: string;
    child: string;
    invocations: number;
    /** evaluator nodeName -> times seen, to resolve the most common at emit. */
    evalNames: Map<string, number>;
}

function asObj(p: Record<string, unknown> | string): Record<string, unknown> | null {
    return typeof p === "object" && p !== null ? p : null;
}

function entryInfo(p: Record<string, unknown>): Record<string, unknown> | null {
    const entries = p.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const first = entries[0] as Record<string, unknown>;
    const info = first?.info;
    return typeof info === "object" && info !== null ? (info as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Public: classify a single payload's eventName. Exported for testing. */
export function classifyEvent(payload: Record<string, unknown>): "tree-init" | "tree-completed" | "node-completed" | "other" {
    const ev = payload.eventName;
    if (ev === "AM-TREE-LOGIN-INITIATED") return "tree-init";
    if (ev === "AM-TREE-LOGIN-COMPLETED") return "tree-completed";
    if (ev === "AM-NODE-LOGIN-COMPLETED") return "node-completed";
    return "other";
}

export function analyzeJourneyHistory(events: RawAuthEvent[]): JourneyHistoryReport {
    // 1. Group by transactionId; chronologically order within each txn.
    type Grouped = { txn: string; events: { ts: string; p: Record<string, unknown> }[] };
    const byTxn = new Map<string, Grouped>();
    let processed = 0;

    for (const ev of events) {
        const p = asObj(ev.payload);
        if (!p) continue;
        const txn = str(p.transactionId);
        if (!txn) continue;
        if (classifyEvent(p) === "other") continue;
        processed++;
        if (!byTxn.has(txn)) byTxn.set(txn, { txn, events: [] });
        byTxn.get(txn)!.events.push({ ts: ev.timestamp, p });
    }
    for (const g of byTxn.values()) {
        g.events.sort((a, b) => a.ts.localeCompare(b.ts));
    }

    // 2. Walk each transaction with an open-attempt stack.
    const attempts: JourneyAttempt[] = [];
    // Report-scoped structure accumulators (see NodeStructure).
    const nodeMap = new Map<string, NodeOutcomeStat>();
    const edgeMap = new Map<string, EdgeAcc>();
    const outerSet = new Set<string>();

    const recordNode = (treeName: string, displayName: string, nodeName: string, outcome: string | undefined): NodeOutcomeStat => {
        const key = `${treeName}${SEP}${nodeName}`;
        let n = nodeMap.get(key);
        if (!n) { n = { treeName, nodeName, displayName, visits: 0, outcomes: {} }; nodeMap.set(key, n); }
        n.visits++;
        const o = outcome ?? "(none)";
        n.outcomes[o] = (n.outcomes[o] ?? 0) + 1;
        return n;
    };
    const recordEdge = (parent: string, child: string): EdgeAcc => {
        const key = `${parent}${SEP}${child}`;
        let e = edgeMap.get(key);
        if (!e) { e = { parent, child, invocations: 0, evalNames: new Map() }; edgeMap.set(key, e); }
        e.invocations++;
        return e;
    };

    for (const g of byTxn.values()) {
        const stack: OpenAttempt[] = [];
        let outerTreeName: string | undefined;
        // Node visits seen while no INITIATED attempt is open. Tenants that omit
        // AM-TREE-LOGIN-INITIATED still let us reconstruct attempts: buffer the
        // orphan node visits here and attach them (and their outcome stats) to the
        // next COMPLETED, once it reveals which tree they belonged to.
        let pendingNodes: { displayName?: string; nodeName?: string; outcome?: string; ts: string; userId?: string }[] = [];
        // Synth attempts (no INITIATED) in completion order. Inner trees complete
        // before their parent, so the LAST is the outer journey and earlier ones
        // are its inner trees — reconstructed at end-of-transaction.
        const synthAttempts: { ref: JourneyAttempt; tree: string }[] = [];

        for (const { ts, p } of g.events) {
            const info = entryInfo(p);
            const kind = classifyEvent(p);

            if (kind === "tree-init") {
                const treeName = str(info?.treeName) ?? str(p.treeName) ?? "(unknown)";
                if (!outerTreeName) outerTreeName = treeName;
                const parent = stack[stack.length - 1];
                if (parent) recordEdge(parent.treeName, treeName); // inner-tree nesting
                else outerSet.add(treeName);                       // entrypoint journey
                stack.push({
                    treeName,
                    startedAt: ts,
                    realm: str(p.realm) ?? str(info?.realm),
                    userId: str(p.userId) ?? str(p.principal),
                    isOuter: stack.length === 0,
                });
                continue;
            }

            if (kind === "node-completed") {
                const display = str(info?.displayName) ?? str(info?.nodeName) ?? "(unknown)";
                const nodeName = str(info?.nodeName) ?? str(info?.displayName) ?? "(unknown)";
                const outcome = str(info?.nodeOutcome);
                // Stash on the topmost open attempt for failure attribution.
                const top = stack[stack.length - 1];
                if (top) {
                    // Per-node outcome stats: attribute to the currently-executing tree.
                    const node = recordNode(top.treeName, display, nodeName, outcome);
                    top.lastNodeDisplayName = str(info?.displayName) ?? str(info?.nodeName) ?? top.lastNodeDisplayName;
                    top.lastNodeOutcome = outcome ?? top.lastNodeOutcome;
                    // userId may only become known mid-flow.
                    top.userId = top.userId ?? str(p.userId) ?? str(p.principal);
                    // Best-effort evaluator linkage: the first node-completed in the
                    // parent right after an inner tree finished is its evaluator.
                    if (top.awaitingEvaluatorFor) {
                        const child = top.awaitingEvaluatorFor;
                        node.evaluatorForTree = child;
                        const edge = edgeMap.get(`${top.treeName}${SEP}${child}`);
                        if (edge) edge.evalNames.set(nodeName, (edge.evalNames.get(nodeName) ?? 0) + 1);
                        top.awaitingEvaluatorFor = undefined;
                    }
                } else {
                    // No open INITIATED attempt — buffer; the COMPLETED reveals the
                    // owning tree, so its outcome stats are recorded there (otherwise
                    // tenants that omit INITIATED would lose all node outcomes).
                    pendingNodes.push({
                        displayName: str(info?.displayName) ?? str(info?.nodeName),
                        nodeName: str(info?.nodeName) ?? str(info?.displayName),
                        outcome,
                        ts,
                        userId: str(p.userId) ?? str(p.principal),
                    });
                }
                continue;
            }

            if (kind === "tree-completed") {
                const treeName = str(info?.treeName) ?? str(p.treeName);
                const result = str(p.result);
                // Pop the most recent matching INITIATED for this treeName.
                let idx = -1;
                if (treeName) {
                    for (let i = stack.length - 1; i >= 0; i--) {
                        if (stack[i].treeName === treeName) { idx = i; break; }
                    }
                }
                if (idx < 0) idx = stack.length - 1; // fallback: top of stack

                const outcome: JourneyAttempt["outcome"] =
                    result === "SUCCESSFUL" ? "success"
                        : result === "FAILED" ? "fail"
                            : "incomplete";

                if (idx < 0) {
                    // No open INITIATED — tenant omitted journey-start. Synthesize
                    // the attempt from this COMPLETED plus the buffered node visits
                    // (those seen since the previous COMPLETED in this transaction).
                    const synthTree = treeName ?? "(unknown)";
                    if (!outerTreeName) outerTreeName = synthTree;
                    const lastNode = pendingNodes[pendingNodes.length - 1];
                    const firstNode = pendingNodes[0];
                    // outer/inner + outerSet are decided at end-of-transaction once we
                    // know which COMPLETED is last (the outermost journey).
                    const synthAttempt: JourneyAttempt = {
                        transactionId: g.txn,
                        treeName: synthTree,
                        isInner: false,
                        outerTreeName: synthTree,
                        realm: str(p.realm) ?? str(info?.realm),
                        userId: str(p.userId) ?? str(p.principal) ?? lastNode?.userId,
                        startedAt: firstNode?.ts ?? ts,
                        completedAt: ts,
                        outcome,
                        failureNode: outcome === "fail" ? lastNode?.displayName : undefined,
                        failureNodeOutcome: outcome === "fail" ? lastNode?.outcome : undefined,
                    };
                    attempts.push(synthAttempt);
                    synthAttempts.push({ ref: synthAttempt, tree: synthTree });
                    // Now that the tree is known, record the buffered nodes' outcomes.
                    for (const pn of pendingNodes) {
                        recordNode(synthTree, pn.displayName ?? pn.nodeName ?? "(unknown)", pn.nodeName ?? pn.displayName ?? "(unknown)", pn.outcome);
                    }
                    pendingNodes = [];
                    continue;
                }

                const open = stack.splice(idx, 1)[0];
                // An inner tree just finished: the next node-completed attributed to
                // the parent is its best-effort evaluator (carries the inner result).
                if (!open.isOuter) {
                    const parent = stack[stack.length - 1];
                    if (parent) parent.awaitingEvaluatorFor = open.treeName;
                }

                attempts.push({
                    transactionId: g.txn,
                    treeName: open.treeName,
                    isInner: !open.isOuter,
                    outerTreeName: outerTreeName ?? open.treeName,
                    realm: open.realm,
                    userId: open.userId ?? str(p.userId) ?? str(p.principal),
                    startedAt: open.startedAt,
                    completedAt: ts,
                    outcome,
                    failureNode: outcome === "fail" ? open.lastNodeDisplayName : undefined,
                    failureNodeOutcome: outcome === "fail" ? open.lastNodeOutcome : undefined,
                });
            }
        }

        // 3. Any still-open attempts at end of transaction → incomplete.
        for (const open of stack) {
            attempts.push({
                transactionId: g.txn,
                treeName: open.treeName,
                isInner: !open.isOuter,
                outerTreeName: outerTreeName ?? open.treeName,
                realm: open.realm,
                userId: open.userId,
                startedAt: open.startedAt,
                outcome: "incomplete",
            });
        }
        // Buffered nodes never closed by a COMPLETED: attribute to the best tree we
        // know (outermost), else a synthetic bucket, so their outcomes aren't lost.
        const leftoverOwner = outerTreeName ?? stack[0]?.treeName ?? "(unknown)";
        for (const pn of pendingNodes) {
            recordNode(leftoverOwner, pn.displayName ?? pn.nodeName ?? "(unknown)", pn.nodeName ?? pn.displayName ?? "(unknown)", pn.outcome);
        }
        // Reconstruct inner-tree nesting for INITIATED-less tenants: the last synth
        // COMPLETED is the outer journey; earlier ones are its inner trees.
        if (synthAttempts.length > 0) {
            const outer = synthAttempts[synthAttempts.length - 1];
            outerSet.add(outer.tree);
            for (let i = 0; i < synthAttempts.length - 1; i++) {
                const inner = synthAttempts[i];
                inner.ref.isInner = true;
                inner.ref.outerTreeName = outer.tree;
                if (inner.tree !== outer.tree) recordEdge(outer.tree, inner.tree);
            }
        }
    }

    // 4. Roll up per-journey.
    const perJourneyMap = new Map<string, PerJourneyStat & { _failNodes: Map<string, number>; _outerCount: number }>();
    for (const a of attempts) {
        let stat = perJourneyMap.get(a.treeName);
        if (!stat) {
            stat = {
                treeName: a.treeName,
                innerOnly: true,
                attempts: 0,
                success: 0,
                fail: 0,
                incomplete: 0,
                failRate: 0,
                topFailureNodes: [],
                _failNodes: new Map(),
                _outerCount: 0,
            };
            perJourneyMap.set(a.treeName, stat);
        }
        stat.attempts++;
        if (a.outcome === "success") stat.success++;
        else if (a.outcome === "fail") stat.fail++;
        else stat.incomplete++;
        if (!a.isInner) { stat._outerCount++; stat.innerOnly = false; }
        if (a.outcome === "fail" && a.failureNode) {
            stat._failNodes.set(a.failureNode, (stat._failNodes.get(a.failureNode) ?? 0) + 1);
        }
    }
    const perJourney: PerJourneyStat[] = [];
    for (const stat of perJourneyMap.values()) {
        const denom = stat.attempts - stat.incomplete;
        stat.failRate = denom > 0 ? stat.fail / denom : 0;
        stat.topFailureNodes = Array.from(stat._failNodes.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([node, count]) => ({ node, count }));
        // Strip internal fields.
        const { _failNodes: _f, _outerCount: _o, ...pub } = stat;
        void _f; void _o;
        perJourney.push(pub);
    }
    perJourney.sort((a, b) => b.attempts - a.attempts);

    const summary = {
        eventsProcessed: processed,
        attempts: attempts.length,
        success: attempts.filter((a) => a.outcome === "success").length,
        fail: attempts.filter((a) => a.outcome === "fail").length,
        incomplete: attempts.filter((a) => a.outcome === "incomplete").length,
        transactions: byTxn.size,
    };

    // 5. Emit the node/tree structure.
    const nodes = Array.from(nodeMap.values()).sort((a, b) => b.visits - a.visits);
    const edges: TreeEdge[] = Array.from(edgeMap.values()).map((e) => {
        const evaluatorNodeName = mostCommon(e.evalNames);
        return { parent: e.parent, child: e.child, invocations: e.invocations, ...(evaluatorNodeName ? { evaluatorNodeName } : {}) };
    });
    const nodeStructure: NodeStructure = { outerTrees: Array.from(outerSet), edges, nodes };

    return { summary, attempts, perJourney, nodeStructure };
}

/** Key of the highest-count entry, or undefined for an empty tally. */
function mostCommon(m: Map<string, number>): string | undefined {
    let best: string | undefined; let bestN = -1;
    for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
    return best;
}

// nodeStructure is optional on the rollup so legacy/partial rollups (and merges
// seeded from them) remain valid; mergeRollup/emptyRollup always populate it.
export type JourneyRollup = Pick<JourneyHistoryReport, "summary" | "perJourney"> & { nodeStructure?: NodeStructure };

/** A zero rollup to seed a merge. */
export function emptyRollup(): JourneyRollup {
    return {
        summary: { eventsProcessed: 0, attempts: 0, success: 0, fail: 0, incomplete: 0, transactions: 0 },
        perJourney: [],
        nodeStructure: { outerTrees: [], edges: [], nodes: [] },
    };
}

/**
 * Fold one window's report into a running rollup. Counts are additive; failRate
 * is recomputed from merged totals; topFailureNodes counts are summed and re-
 * topped (capped at 5). Used by the windowed report runner so a long range is
 * analyzed one window at a time and the whole span never sits in memory.
 *
 * Note: a journey that straddles a window boundary is counted in both windows
 * (incomplete in the earlier, reconstructed in the later) — negligible for
 * seconds-long auth journeys over day/week windows.
 */
export function mergeRollup(acc: JourneyRollup, next: JourneyRollup): JourneyRollup {
    const summary = {
        eventsProcessed: acc.summary.eventsProcessed + next.summary.eventsProcessed,
        attempts: acc.summary.attempts + next.summary.attempts,
        success: acc.summary.success + next.summary.success,
        fail: acc.summary.fail + next.summary.fail,
        incomplete: acc.summary.incomplete + next.summary.incomplete,
        transactions: acc.summary.transactions + next.summary.transactions,
    };

    const byTree = new Map<string, { stat: PerJourneyStat; nodes: Map<string, number> }>();
    const fold = (p: PerJourneyStat) => {
        const cur = byTree.get(p.treeName);
        if (!cur) {
            byTree.set(p.treeName, {
                stat: { ...p, topFailureNodes: [] },
                nodes: new Map(p.topFailureNodes.map((n) => [n.node, n.count])),
            });
            return;
        }
        cur.stat.attempts += p.attempts;
        cur.stat.success += p.success;
        cur.stat.fail += p.fail;
        cur.stat.incomplete += p.incomplete;
        cur.stat.innerOnly = cur.stat.innerOnly && p.innerOnly;
        for (const n of p.topFailureNodes) cur.nodes.set(n.node, (cur.nodes.get(n.node) ?? 0) + n.count);
    };
    for (const p of acc.perJourney) fold(p);
    for (const p of next.perJourney) fold(p);

    const perJourney: PerJourneyStat[] = [];
    for (const { stat, nodes } of byTree.values()) {
        const denom = stat.attempts - stat.incomplete;
        stat.failRate = denom > 0 ? stat.fail / denom : 0;
        stat.topFailureNodes = [...nodes.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([node, count]) => ({ node, count }));
        perJourney.push(stat);
    }
    perJourney.sort((a, b) => b.attempts - a.attempts);

    return { summary, perJourney, nodeStructure: mergeNodeStructure(acc.nodeStructure, next.nodeStructure) };
}

/** Fold two NodeStructures: additive node visits/outcomes and edge invocations,
 *  union of outerTrees. Tolerates undefined (legacy rollups without structure). */
function mergeNodeStructure(a: NodeStructure | undefined, b: NodeStructure | undefined): NodeStructure {
    const outerTrees = new Set<string>([...(a?.outerTrees ?? []), ...(b?.outerTrees ?? [])]);

    const nodes = new Map<string, NodeOutcomeStat>();
    for (const n of [...(a?.nodes ?? []), ...(b?.nodes ?? [])]) {
        const key = `${n.treeName}${SEP}${n.nodeName}`;
        const cur = nodes.get(key);
        if (!cur) {
            nodes.set(key, { ...n, outcomes: { ...n.outcomes } });
            continue;
        }
        cur.visits += n.visits;
        for (const [o, c] of Object.entries(n.outcomes)) cur.outcomes[o] = (cur.outcomes[o] ?? 0) + c;
        if (!cur.evaluatorForTree && n.evaluatorForTree) cur.evaluatorForTree = n.evaluatorForTree;
    }

    const edges = new Map<string, TreeEdge & { _names: Map<string, number> }>();
    for (const e of [...(a?.edges ?? []), ...(b?.edges ?? [])]) {
        const key = `${e.parent}${SEP}${e.child}`;
        let cur = edges.get(key);
        if (!cur) { cur = { parent: e.parent, child: e.child, invocations: 0, _names: new Map() }; edges.set(key, cur); }
        cur.invocations += e.invocations;
        if (e.evaluatorNodeName) cur._names.set(e.evaluatorNodeName, (cur._names.get(e.evaluatorNodeName) ?? 0) + e.invocations);
    }

    return {
        outerTrees: [...outerTrees],
        edges: [...edges.values()].map(({ _names, ...e }) => {
            const evaluatorNodeName = mostCommon(_names);
            return evaluatorNodeName ? { ...e, evaluatorNodeName } : e;
        }),
        nodes: [...nodes.values()].sort((x, y) => y.visits - x.visits),
    };
}
