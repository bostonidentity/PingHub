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
    for (const g of byTxn.values()) {
        const stack: OpenAttempt[] = [];
        let outerTreeName: string | undefined;
        // Node visits seen while no INITIATED attempt is open. Tenants that omit
        // AM-TREE-LOGIN-INITIATED still let us reconstruct attempts: buffer the
        // orphan node visits here and attach them to the next COMPLETED.
        let pendingNodes: { displayName?: string; outcome?: string; ts: string; userId?: string }[] = [];

        for (const { ts, p } of g.events) {
            const info = entryInfo(p);
            const kind = classifyEvent(p);

            if (kind === "tree-init") {
                const treeName = str(info?.treeName) ?? str(p.treeName) ?? "(unknown)";
                if (!outerTreeName) outerTreeName = treeName;
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
                // Stash on the topmost open attempt for failure attribution.
                const top = stack[stack.length - 1];
                if (top) {
                    top.lastNodeDisplayName = str(info?.displayName) ?? str(info?.nodeName) ?? top.lastNodeDisplayName;
                    top.lastNodeOutcome = str(info?.nodeOutcome) ?? top.lastNodeOutcome;
                    // userId may only become known mid-flow.
                    top.userId = top.userId ?? str(p.userId) ?? str(p.principal);
                } else {
                    // No open INITIATED attempt — buffer for the next COMPLETED.
                    pendingNodes.push({
                        displayName: str(info?.displayName) ?? str(info?.nodeName),
                        outcome: str(info?.nodeOutcome),
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
                    attempts.push({
                        transactionId: g.txn,
                        treeName: synthTree,
                        isInner: false,
                        outerTreeName: outerTreeName ?? synthTree,
                        realm: str(p.realm) ?? str(info?.realm),
                        userId: str(p.userId) ?? str(p.principal) ?? lastNode?.userId,
                        startedAt: firstNode?.ts ?? ts,
                        completedAt: ts,
                        outcome,
                        failureNode: outcome === "fail" ? lastNode?.displayName : undefined,
                        failureNodeOutcome: outcome === "fail" ? lastNode?.outcome : undefined,
                    });
                    pendingNodes = [];
                    continue;
                }

                const open = stack.splice(idx, 1)[0];

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

    return { summary, attempts, perJourney };
}

export type JourneyRollup = Pick<JourneyHistoryReport, "summary" | "perJourney">;

/** A zero rollup to seed a merge. */
export function emptyRollup(): JourneyRollup {
    return {
        summary: { eventsProcessed: 0, attempts: 0, success: 0, fail: 0, incomplete: 0, transactions: 0 },
        perJourney: [],
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

    return { summary, perJourney };
}
