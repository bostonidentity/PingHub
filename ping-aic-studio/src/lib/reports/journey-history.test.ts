import { describe, it, expect } from "vitest";
import { analyzeJourneyHistory, emptyRollup, mergeRollup, traceOf, counterOf, type RawAuthEvent } from "./journey-history";

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

/** Node-completed event with full control over the info block (tree/type/etc.). */
function nodeEv(ts: string, txn: string, o: { tree?: string; display: string; name?: string; outcome?: string; type?: string }): RawAuthEvent {
    const info: Record<string, unknown> = { displayName: o.display };
    if (o.tree) info.treeName = o.tree;
    if (o.name) info.nodeName = o.name;
    if (o.outcome !== undefined) info.nodeOutcome = o.outcome;
    if (o.type) info.nodeType = o.type;
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

    it("keeps synth failure attribution for buffered nodes that carried their own treeName", () => {
        const events: RawAuthEvent[] = [
            nodeEv("2026-06-03T10:00:01Z", "n5", { tree: "Master", display: "Page Node", outcome: "true" }),
            nodeEv("2026-06-03T10:00:02Z", "n5", { tree: "Master", display: "MFA Check", outcome: "Failure" }),
            completed("2026-06-03T10:00:03Z", "n5", "Master", "FAILED"),
        ];
        const r = analyzeJourneyHistory(events);
        expect(r.attempts[0]).toMatchObject({
            treeName: "Master", outcome: "fail",
            failureNode: "MFA Check", failureNodeOutcome: "Failure",
            startedAt: "2026-06-03T10:00:01Z",
        });
    });

    describe("mergeRollup folds nodeStructure", () => {
        it("sums node visits/outcomes and edge invocations, unions outerTrees", () => {
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
            const merged = mergeRollup(mergeRollup(emptyRollup(), w1), w2);
            const ns = merged.nodeStructure!;
            const lookup = ns.nodes.find((n) => n.displayName === "Lookup")!;
            expect(lookup.outcomes).toEqual({ TRUE: 1, FALSE: 1 });
            expect(ns.edges).toEqual([{ parent: "Login", child: "Inner", invocations: 2, evaluatorNodeName: "InnerEval" }]);
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
