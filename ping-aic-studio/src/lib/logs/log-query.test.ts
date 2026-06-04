import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { appendEntries } from "./log-archive-store";
import { queryArchive } from "./log-query";
import type { RawLogEntry } from "./log-types";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-query-"));
}
function entry(id: string, ts: string, over: Record<string, unknown> = {}): RawLogEntry {
    return { timestamp: ts, source: "am-authentication", payload: { _id: id, eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: "t1", level: "INFO", realm: "/alpha", principal: "alice", ...over } };
}

describe("queryArchive", () => {
    it("returns matching rows across day partitions, timestamp-ordered, with total", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T23:30:00Z"),
            entry("c", "2026-06-03T00:30:00Z"),
        ]);
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T12:00:00Z" });
        expect(res.total).toBe(3);
        expect(res.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
        expect(res.rows[0].source).toBe("am-authentication");
        expect(res.capped).toBe(false);
    });

    it("applies eventName/level/text filters", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z", { eventName: "AM-TREE-LOGIN-COMPLETED", level: "ERROR" }),
            entry("b", "2026-06-02T02:00:00Z", { eventName: "AM-NODE-LOGIN-COMPLETED", level: "INFO" }),
        ]);
        expect(queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", level: "ERROR" }).rows.map((r) => r.id)).toEqual(["a"]);
        expect(queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", eventName: "AM-NODE-LOGIN-COMPLETED" }).rows.map((r) => r.id)).toEqual(["b"]);
    });

    it("paginates with offset/limit while reporting the full total", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T02:00:00Z"),
            entry("c", "2026-06-02T03:00:00Z"),
        ]);
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", offset: 1, limit: 1 });
        expect(res.total).toBe(3);
        expect(res.rows.map((r) => r.id)).toEqual(["b"]);
    });

    it("merges multiple sources timestamp-ordered and skips absent sources", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [entry("a", "2026-06-02T01:00:00Z")]);
        appendEntries(root, "am-access", [{ timestamp: "2026-06-02T01:30:00Z", source: "am-access", payload: { _id: "x", eventName: "AM-ACCESS", transactionId: "t9", level: "INFO", realm: "/alpha" } }]);
        const res = queryArchive(root, { sources: ["am-authentication", "am-access", "idm-activity"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" });
        expect(res.rows.map((r) => `${r.source}:${r.id}`)).toEqual(["am-authentication:a", "am-access:x"]);
        expect(res.total).toBe(2);
    });

    it("returns empty when nothing is archived", () => {
        const root = tmpRoot();
        const res = queryArchive(root, { sources: ["am-core"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" });
        expect(res).toEqual({ total: 0, rows: [], capped: false });
    });

    it("caps row materialization while keeping total exact", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T02:00:00Z"),
            entry("c", "2026-06-02T03:00:00Z"),
        ]);
        // Force the cap at 2 rows.
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }, 2);
        expect(res.capped).toBe(true);
        expect(res.total).toBe(3);          // exact, via per-day COUNT
        expect(res.rows.length).toBe(2);    // materialized up to the cap
    });

    it("filters by free text at the archive layer", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z", { principal: "alice" }),
            entry("b", "2026-06-02T02:00:00Z", { principal: "bob" }),
        ]);
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", text: "alice" });
        expect(res.rows.map((r) => r.id)).toEqual(["a"]);
    });
});
