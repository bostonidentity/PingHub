import { describe, it, expect } from "vitest";
import { analyzeJourneyHistory, emptyRollup, mergeRollup, type RawAuthEvent } from "./journey-history";

// ── Test fixture helpers ───────────────────────────────────────────────────

function init(ts: string, txn: string, tree: string, extra: Record<string, unknown> = {}): RawAuthEvent {
    return {
        timestamp: ts,
        payload: { eventName: "AM-TREE-LOGIN-INITIATED", transactionId: txn, entries: [{ info: { treeName: tree } }], ...extra },
    };
}
function nodeVisit(ts: string, txn: string, display: string, outcome: string): RawAuthEvent {
    return {
        timestamp: ts,
        payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: txn, entries: [{ info: { displayName: display, nodeOutcome: outcome } }] },
    };
}
function completed(ts: string, txn: string, tree: string, result: "SUCCESSFUL" | "FAILED"): RawAuthEvent {
    return {
        timestamp: ts,
        payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: txn, result, entries: [{ info: { treeName: tree } }] },
    };
}

describe("analyzeJourneyHistory", () => {
    it("returns empty report for no events", () => {
        const r = analyzeJourneyHistory([]);
        expect(r.summary).toEqual({ eventsProcessed: 0, attempts: 0, success: 0, fail: 0, incomplete: 0, transactions: 0 });
        expect(r.attempts).toEqual([]);
        expect(r.perJourney).toEqual([]);
    });

    it("pairs INITIATED with COMPLETED on a successful single-journey attempt", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t1", "Login"),
            nodeVisit("2026-06-03T10:00:01Z", "t1", "Username/Password", "success"),
            completed("2026-06-03T10:00:02Z", "t1", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.summary.attempts).toBe(1);
        expect(r.summary.success).toBe(1);
        expect(r.attempts[0]).toMatchObject({
            transactionId: "t1", treeName: "Login", isInner: false, outcome: "success",
        });
    });

    it("captures failure node display name from the last node visit before FAILED", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t2", "Login"),
            nodeVisit("2026-06-03T10:00:01Z", "t2", "Username/Password", "success"),
            nodeVisit("2026-06-03T10:00:02Z", "t2", "MFA Challenge", "Failure"),
            completed("2026-06-03T10:00:03Z", "t2", "Login", "FAILED"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.attempts[0].outcome).toBe("fail");
        expect(r.attempts[0].failureNode).toBe("MFA Challenge");
        expect(r.attempts[0].failureNodeOutcome).toBe("Failure");
    });

    it("treats nested inner-journey INITIATED/COMPLETED as a separate attempt with isInner=true", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t3", "Login"),
            nodeVisit("2026-06-03T10:00:01Z", "t3", "Username/Password", "success"),
            // Outer journey enters InnerTreeEvaluator → inner tree starts:
            init("2026-06-03T10:00:02Z", "t3", "MFA-Inner"),
            nodeVisit("2026-06-03T10:00:03Z", "t3", "Push Notification", "success"),
            completed("2026-06-03T10:00:04Z", "t3", "MFA-Inner", "SUCCESSFUL"),
            // Back to outer:
            completed("2026-06-03T10:00:05Z", "t3", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.summary.attempts).toBe(2);
        const outer = r.attempts.find((a) => a.treeName === "Login")!;
        const inner = r.attempts.find((a) => a.treeName === "MFA-Inner")!;
        expect(outer.isInner).toBe(false);
        expect(outer.outerTreeName).toBe("Login");
        expect(inner.isInner).toBe(true);
        expect(inner.outerTreeName).toBe("Login");
        expect(inner.outcome).toBe("success");
    });

    it("marks unclosed INITIATEDs as incomplete (user abandoned)", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t4", "Login"),
            nodeVisit("2026-06-03T10:00:01Z", "t4", "Username/Password", "success"),
            // no COMPLETED for t4
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.summary.attempts).toBe(1);
        expect(r.summary.incomplete).toBe(1);
        expect(r.attempts[0].outcome).toBe("incomplete");
        expect(r.attempts[0].completedAt).toBeUndefined();
    });

    it("rolls per-journey stats and reports topFailureNodes by count", () => {
        const events: RawAuthEvent[] = [];
        // Login: 3 success, 2 fail (both fail at MFA), 1 fail at Password.
        for (let i = 0; i < 3; i++) {
            events.push(init(`2026-06-03T10:00:0${i}Z`, `s${i}`, "Login"));
            events.push(completed(`2026-06-03T10:00:1${i}Z`, `s${i}`, "Login", "SUCCESSFUL"));
        }
        for (let i = 0; i < 2; i++) {
            events.push(init(`2026-06-03T10:01:0${i}.000Z`, `f${i}`, "Login"));
            events.push(nodeVisit(`2026-06-03T10:01:0${i}.500Z`, `f${i}`, "MFA", "Failure"));
            events.push(completed(`2026-06-03T10:01:0${i}.900Z`, `f${i}`, "Login", "FAILED"));
        }
        events.push(init("2026-06-03T10:02:00.000Z", "p1", "Login"));
        events.push(nodeVisit("2026-06-03T10:02:00.500Z", "p1", "Password", "Failure"));
        events.push(completed("2026-06-03T10:02:00.900Z", "p1", "Login", "FAILED"));

        const r = analyzeJourneyHistory(events);
        const login = r.perJourney.find((p) => p.treeName === "Login")!;
        expect(login).toMatchObject({ attempts: 6, success: 3, fail: 3, incomplete: 0, innerOnly: false });
        expect(login.failRate).toBeCloseTo(0.5);
        expect(login.topFailureNodes).toEqual([
            { node: "MFA", count: 2 },
            { node: "Password", count: 1 },
        ]);
    });

    // Some AIC tenants do not emit AM-TREE-LOGIN-INITIATED at all; we must still
    // reconstruct attempts from AM-TREE-LOGIN-COMPLETED (+ preceding node visits).
    describe("without INITIATED events (tenant omits journey-start)", () => {
        it("reconstructs a successful attempt from COMPLETED alone", () => {
            const events: RawAuthEvent[] = [
                nodeVisit("2026-06-03T10:00:01Z", "n1", "Username/Password", "success"),
                completed("2026-06-03T10:00:02Z", "n1", "Login", "SUCCESSFUL"),
            ];
            const r = analyzeJourneyHistory(events);
            expect(r.summary.attempts).toBe(1);
            expect(r.summary.success).toBe(1);
            expect(r.attempts[0]).toMatchObject({
                transactionId: "n1", treeName: "Login", isInner: false, outcome: "success",
            });
            expect(r.attempts[0].completedAt).toBe("2026-06-03T10:00:02Z");
        });

        it("attributes the failure node from the last node before a FAILED COMPLETED", () => {
            const events: RawAuthEvent[] = [
                nodeVisit("2026-06-03T10:00:01Z", "n2", "Username/Password", "success"),
                nodeVisit("2026-06-03T10:00:02Z", "n2", "MFA Challenge", "Failure"),
                completed("2026-06-03T10:00:03Z", "n2", "Login", "FAILED"),
            ];
            const r = analyzeJourneyHistory(events);
            expect(r.attempts[0].outcome).toBe("fail");
            expect(r.attempts[0].failureNode).toBe("MFA Challenge");
            expect(r.attempts[0].failureNodeOutcome).toBe("Failure");
        });

        it("reconstructs two COMPLETEDs in one transaction as two attempts", () => {
            const events: RawAuthEvent[] = [
                nodeVisit("2026-06-03T10:00:01Z", "n3", "Username/Password", "success"),
                nodeVisit("2026-06-03T10:00:02Z", "n3", "Push", "success"),
                completed("2026-06-03T10:00:03Z", "n3", "MFA-Inner", "SUCCESSFUL"),
                nodeVisit("2026-06-03T10:00:04Z", "n3", "Set Session", "success"),
                completed("2026-06-03T10:00:05Z", "n3", "Login", "SUCCESSFUL"),
            ];
            const r = analyzeJourneyHistory(events);
            expect(r.summary.attempts).toBe(2);
            expect(r.attempts.map((a) => a.treeName).sort()).toEqual(["Login", "MFA-Inner"]);
        });

        it("reconstructs a bare COMPLETED with no preceding node visits", () => {
            const events: RawAuthEvent[] = [
                completed("2026-06-03T10:00:02Z", "n4", "Login", "SUCCESSFUL"),
            ];
            const r = analyzeJourneyHistory(events);
            expect(r.summary.attempts).toBe(1);
            expect(r.attempts[0]).toMatchObject({ treeName: "Login", outcome: "success" });
            expect(r.attempts[0].startedAt).toBe("2026-06-03T10:00:02Z");
        });
    });

    it("ignores unrelated eventNames and payloads without transactionId", () => {
        const events: RawAuthEvent[] = [
            { timestamp: "2026-06-03T10:00:00Z", payload: { eventName: "AM-LOGOUT" } },
            { timestamp: "2026-06-03T10:00:01Z", payload: "plain text log line" },
            { timestamp: "2026-06-03T10:00:02Z", payload: { eventName: "AM-TREE-LOGIN-INITIATED" /* no txn */ } },
            init("2026-06-03T10:00:03Z", "t5", "Login"),
            completed("2026-06-03T10:00:04Z", "t5", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.summary.attempts).toBe(1);
        expect(r.summary.eventsProcessed).toBe(2);
    });

    describe("mergeRollup", () => {
        it("sums counts, recomputes failRate, and ANDs innerOnly across windows", () => {
            const w1 = {
                summary: { eventsProcessed: 3, attempts: 3, success: 2, fail: 1, incomplete: 0, transactions: 3 },
                perJourney: [{
                    treeName: "Login", innerOnly: false, attempts: 3, success: 2, fail: 1, incomplete: 0,
                    failRate: 1 / 3, topFailureNodes: [{ node: "Password", count: 1 }],
                }],
            };
            const w2 = {
                summary: { eventsProcessed: 2, attempts: 2, success: 0, fail: 1, incomplete: 1, transactions: 2 },
                perJourney: [{
                    treeName: "Login", innerOnly: true, attempts: 2, success: 0, fail: 1, incomplete: 1,
                    failRate: 1, topFailureNodes: [{ node: "Password", count: 1 }, { node: "MFA", count: 1 }],
                }],
            };

            const merged = mergeRollup(mergeRollup(emptyRollup(), w1), w2);

            expect(merged.summary).toEqual({ eventsProcessed: 5, attempts: 5, success: 2, fail: 2, incomplete: 1, transactions: 5 });
            expect(merged.perJourney).toHaveLength(1);
            const j = merged.perJourney[0];
            expect(j).toMatchObject({ treeName: "Login", attempts: 5, success: 2, fail: 2, incomplete: 1 });
            // failRate = fail / (attempts - incomplete) = 2 / 4
            expect(j.failRate).toBeCloseTo(0.5);
            // innerOnly = false AND true = false (appeared as outer in w1)
            expect(j.innerOnly).toBe(false);
            // Failure-node counts summed across windows.
            expect(j.topFailureNodes).toEqual([{ node: "Password", count: 2 }, { node: "MFA", count: 1 }]);
        });

        it("keeps distinct journeys separate", () => {
            const a = { summary: { eventsProcessed: 1, attempts: 1, success: 1, fail: 0, incomplete: 0, transactions: 1 },
                perJourney: [{ treeName: "A", innerOnly: false, attempts: 1, success: 1, fail: 0, incomplete: 0, failRate: 0, topFailureNodes: [] }] };
            const b = { summary: { eventsProcessed: 1, attempts: 1, success: 0, fail: 1, incomplete: 0, transactions: 1 },
                perJourney: [{ treeName: "B", innerOnly: false, attempts: 1, success: 0, fail: 1, incomplete: 0, failRate: 1, topFailureNodes: [] }] };
            const merged = mergeRollup(mergeRollup(emptyRollup(), a), b);
            expect(merged.perJourney.map((p) => p.treeName).sort()).toEqual(["A", "B"]);
        });
    });
});

// ── Node outcomes & tree structure ─────────────────────────────────────────

/** Node visit allowing an explicit internal nodeName (else falls back to display). */
function nodeVisitN(ts: string, txn: string, display: string, outcome: string | undefined, name?: string): RawAuthEvent {
    const info: Record<string, unknown> = { displayName: display };
    if (name) info.nodeName = name;
    if (outcome !== undefined) info.nodeOutcome = outcome;
    return { timestamp: ts, payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: txn, entries: [{ info }] } };
}

describe("nodeStructure", () => {
    it("aggregates per-node outcomes with visit counts and a (none) bucket", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t1", "Login"),
            nodeVisitN("2026-06-03T10:00:01Z", "t1", "User ID Lookup", "TRUE"),
            nodeVisitN("2026-06-03T10:00:02Z", "t1", "User ID Lookup", "TRUE"),
            nodeVisitN("2026-06-03T10:00:03Z", "t1", "User ID Lookup", "FALSE"),
            nodeVisitN("2026-06-03T10:00:04Z", "t1", "User ID Lookup", undefined),
            completed("2026-06-03T10:00:05Z", "t1", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        const node = r.nodeStructure.nodes.find((n) => n.displayName === "User ID Lookup")!;
        expect(node).toMatchObject({ treeName: "Login", nodeName: "User ID Lookup", visits: 4 });
        expect(node.outcomes).toEqual({ TRUE: 2, FALSE: 1, "(none)": 1 });
        expect(r.nodeStructure.outerTrees).toEqual(["Login"]);
        expect(r.nodeStructure.edges).toEqual([]);
    });

    it("records parent→child edges and outerTrees for inner trees, and links the evaluator outcome", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t3", "Login"),
            nodeVisitN("2026-06-03T10:00:01Z", "t3", "User ID Lookup", "TRUE"),
            init("2026-06-03T10:00:02Z", "t3", "MFA-Inner"),
            nodeVisitN("2026-06-03T10:00:03Z", "t3", "Push", "Approved"),
            completed("2026-06-03T10:00:04Z", "t3", "MFA-Inner", "SUCCESSFUL"),
            // Parent's InnerTreeEvaluatorNode fires right after the inner tree completes:
            nodeVisitN("2026-06-03T10:00:05Z", "t3", "Evaluate MFA", "Continue", "MfaEvaluator"),
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

    it("handles three levels of nesting (depth is unbounded)", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t", "Login"),
            init("2026-06-03T10:00:01Z", "t", "A"),
            init("2026-06-03T10:00:02Z", "t", "B"),
            nodeVisitN("2026-06-03T10:00:03Z", "t", "Deep", "x"),
            completed("2026-06-03T10:00:04Z", "t", "B", "SUCCESSFUL"),
            completed("2026-06-03T10:00:05Z", "t", "A", "SUCCESSFUL"),
            completed("2026-06-03T10:00:06Z", "t", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.nodeStructure.outerTrees).toEqual(["Login"]);
        const edges = r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`).sort();
        expect(edges).toEqual(["A>B", "Login>A"]);
    });

    it("leaves an edge evaluator-less when no node follows the inner tree", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t", "Login"),
            init("2026-06-03T10:00:01Z", "t", "Inner"),
            nodeVisitN("2026-06-03T10:00:02Z", "t", "X", "ok"),
            completed("2026-06-03T10:00:03Z", "t", "Inner", "SUCCESSFUL"),
            completed("2026-06-03T10:00:04Z", "t", "Login", "SUCCESSFUL"), // no node between
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.nodeStructure.edges).toEqual([{ parent: "Login", child: "Inner", invocations: 1 }]);
    });

    it("yields two edges and one merged node set for a reused inner tree", () => {
        const mk = (txn: string, parent: string): RawAuthEvent[] => [
            init("2026-06-03T10:00:00Z", txn, parent),
            init("2026-06-03T10:00:01Z", txn, "Shared"),
            nodeVisitN("2026-06-03T10:00:02Z", txn, "Common", "ok"),
            completed("2026-06-03T10:00:03Z", txn, "Shared", "SUCCESSFUL"),
            completed("2026-06-03T10:00:04Z", txn, parent, "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory([...mk("a", "Login"), ...mk("b", "Register")]);
        const edges = r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`).sort();
        expect(edges).toEqual(["Login>Shared", "Register>Shared"]);
        const common = r.nodeStructure.nodes.filter((n) => n.displayName === "Common");
        expect(common).toHaveLength(1);
        expect(common[0]).toMatchObject({ treeName: "Shared", visits: 2 });
    });

    it("attributes node outcomes to the synthesized tree when INITIATED is omitted", () => {
        // Tenant emits no AM-TREE-LOGIN-INITIATED: node events arrive before the
        // COMPLETED reveals the tree. Their outcomes must still land on that tree.
        const events: RawAuthEvent[] = [
            nodeVisitN("2026-06-03T10:00:01Z", "n1", "Check Session", "noSession"),
            nodeVisitN("2026-06-03T10:00:02Z", "n1", "Fetch App ID", "true"),
            completed("2026-06-03T10:00:03Z", "n1", "MasterLogin", "SUCCESSFUL"),
            // second attempt, same tenant style:
            nodeVisitN("2026-06-03T10:01:01Z", "n2", "Check Session", "noSession"),
            completed("2026-06-03T10:01:02Z", "n2", "MasterLogin", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.nodeStructure.outerTrees).toEqual(["MasterLogin"]);
        const check = r.nodeStructure.nodes.find((n) => n.displayName === "Check Session")!;
        expect(check).toMatchObject({ treeName: "MasterLogin", visits: 2 });
        expect(check.outcomes).toEqual({ noSession: 2 });
        // No node should leak into an "(unknown)" bucket.
        expect(r.nodeStructure.nodes.some((n) => n.treeName === "(unknown)")).toBe(false);
    });

    it("reconstructs inner-tree nesting when INITIATED is omitted (last COMPLETED is outer)", () => {
        // No INITIATED: inner tree B completes before outer journey A in one txn.
        const events: RawAuthEvent[] = [
            nodeVisitN("2026-06-03T10:00:01Z", "x", "B Step", "ok"),
            completed("2026-06-03T10:00:02Z", "x", "B", "SUCCESSFUL"),       // inner first
            nodeVisitN("2026-06-03T10:00:03Z", "x", "A Eval", "Continue"),
            completed("2026-06-03T10:00:04Z", "x", "A", "SUCCESSFUL"),       // outer last
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.nodeStructure.outerTrees).toEqual(["A"]);
        expect(r.nodeStructure.edges.map((e) => `${e.parent}>${e.child}`)).toEqual(["A>B"]);
        expect(r.attempts.find((a) => a.treeName === "B")!).toMatchObject({ isInner: true, outerTreeName: "A" });
        expect(r.attempts.find((a) => a.treeName === "A")!).toMatchObject({ isInner: false });
    });

    it("produces empty nodes (but can still see edges) when no node events are present", () => {
        const events: RawAuthEvent[] = [
            init("2026-06-03T10:00:00Z", "t", "Login"),
            init("2026-06-03T10:00:01Z", "t", "Inner"),
            completed("2026-06-03T10:00:02Z", "t", "Inner", "SUCCESSFUL"),
            completed("2026-06-03T10:00:03Z", "t", "Login", "SUCCESSFUL"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.nodeStructure.nodes).toEqual([]);
        expect(r.nodeStructure.edges).toEqual([{ parent: "Login", child: "Inner", invocations: 1 }]);
    });

    describe("mergeRollup folds nodeStructure", () => {
        it("sums node visits/outcomes and edge invocations, unions outerTrees", () => {
            const w1 = analyzeJourneyHistory([
                init("2026-06-03T10:00:00Z", "a", "Login"),
                nodeVisitN("2026-06-03T10:00:01Z", "a", "Lookup", "TRUE"),
                init("2026-06-03T10:00:02Z", "a", "Inner"),
                nodeVisitN("2026-06-03T10:00:03Z", "a", "Deep", "ok"),
                completed("2026-06-03T10:00:04Z", "a", "Inner", "SUCCESSFUL"),
                completed("2026-06-03T10:00:05Z", "a", "Login", "SUCCESSFUL"),
            ]);
            const w2 = analyzeJourneyHistory([
                init("2026-06-03T11:00:00Z", "b", "Login"),
                nodeVisitN("2026-06-03T11:00:01Z", "b", "Lookup", "FALSE"),
                init("2026-06-03T11:00:02Z", "b", "Inner"),
                nodeVisitN("2026-06-03T11:00:03Z", "b", "Deep", "ok"),
                completed("2026-06-03T11:00:04Z", "b", "Inner", "SUCCESSFUL"),
                completed("2026-06-03T11:00:05Z", "b", "Login", "SUCCESSFUL"),
            ]);
            const merged = mergeRollup(mergeRollup(emptyRollup(), w1), w2);
            const ns = merged.nodeStructure!;
            const lookup = ns.nodes.find((n) => n.displayName === "Lookup")!;
            expect(lookup.outcomes).toEqual({ TRUE: 1, FALSE: 1 });
            expect(ns.edges).toEqual([{ parent: "Login", child: "Inner", invocations: 2 }]);
            expect(ns.outerTrees).toEqual(["Login"]);
        });

        it("tolerates rollups without nodeStructure (legacy windows)", () => {
            const legacy = { summary: { eventsProcessed: 1, attempts: 1, success: 1, fail: 0, incomplete: 0, transactions: 1 },
                perJourney: [{ treeName: "Login", innerOnly: false, attempts: 1, success: 1, fail: 0, incomplete: 0, failRate: 0, topFailureNodes: [] }] };
            const merged = mergeRollup(emptyRollup(), legacy);
            expect(merged.nodeStructure).toEqual({ outerTrees: [], edges: [], nodes: [] });
        });
    });
});
