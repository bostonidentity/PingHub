import { describe, it, expect } from "vitest";
import { analyzeJourneyHistory, type RawAuthEvent } from "./journey-history";

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
});
