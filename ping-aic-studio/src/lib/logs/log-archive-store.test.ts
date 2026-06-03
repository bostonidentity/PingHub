import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { extractRow, appendEntries } from "./log-archive-store";
import { dayNdjsonPath, dayDbPath } from "./log-archive-paths";
import { openDayDb, queryDay } from "./log-index";
import type { RawLogEntry } from "./log-types";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-store-"));
}

function entry(id: string, ts: string, over: Record<string, unknown> = {}): RawLogEntry {
    return {
        timestamp: ts,
        source: "am-authentication",
        payload: {
            _id: id, transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED",
            level: "INFO", realm: "/alpha", principal: "alice", ...over,
        },
    };
}

describe("extractRow", () => {
    it("pulls indexable columns from payload, preferring userId then principal", () => {
        const r = extractRow(entry("a", "2026-06-02T00:00:00Z", { userId: "bob" }));
        expect(r).toMatchObject({
            id: "a", transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED",
            level: "INFO", realm: "/alpha", userId: "bob",
        });
        expect(r!.searchable).toContain("am-tree-login-completed");
    });

    it("falls back to principal when userId is absent", () => {
        expect(extractRow(entry("a", "2026-06-02T00:00:00Z"))!.userId).toBe("alice");
    });

    it("returns null when payload._id is missing (no stable dedup key)", () => {
        const e: RawLogEntry = { timestamp: "2026-06-02T00:00:00Z", payload: { eventName: "X" } };
        expect(extractRow(e)).toBeNull();
    });
});

describe("appendEntries", () => {
    it("writes NDJSON + index, partitioned by UTC day, and reports counts", () => {
        const root = tmpRoot();
        const res = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            entry("b", "2026-06-02T23:00:00Z"),
            entry("c", "2026-06-03T00:30:00Z"),
        ]);
        expect(res.inserted).toBe(3);
        expect(res.duplicates).toBe(0);
        expect(res.days.sort()).toEqual(["2026-06-02", "2026-06-03"]);

        const day2 = fs.readFileSync(dayNdjsonPath(root, "am-authentication", "2026-06-02"), "utf-8")
            .trim().split("\n");
        expect(day2).toHaveLength(2);
        expect(JSON.parse(day2[0]).payload._id).toBe("a");
    });

    it("dedupes across calls — re-appending the same entries adds nothing", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [entry("a", "2026-06-02T00:00:00Z")]);
        const res2 = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            entry("d", "2026-06-02T01:00:00Z"),
        ]);
        expect(res2.inserted).toBe(1);
        expect(res2.duplicates).toBe(1);
        const lines = fs.readFileSync(dayNdjsonPath(root, "am-authentication", "2026-06-02"), "utf-8")
            .trim().split("\n");
        expect(lines).toHaveLength(2); // a (from call 1) + d (from call 2); a not duplicated
    });

    it("skips entries with no payload._id", () => {
        const root = tmpRoot();
        const res = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            { timestamp: "2026-06-02T00:00:01Z", payload: { eventName: "no-id" } },
        ]);
        expect(res.inserted).toBe(1);
        expect(res.skipped).toBe(1);
    });

    it("stores byte offsets that point to the correct NDJSON bytes (interleaved new/dup)", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [entry("a", "2026-06-02T00:00:00Z")]);
        const res = appendEntries(root, "am-authentication", [
            entry("b", "2026-06-02T01:00:00Z"),
            entry("a", "2026-06-02T00:00:00Z"), // duplicate
            entry("c", "2026-06-02T02:00:00Z"),
        ]);
        expect(res.inserted).toBe(2);
        expect(res.duplicates).toBe(1);

        const ndjsonPath = dayNdjsonPath(root, "am-authentication", "2026-06-02");
        const buf = fs.readFileSync(ndjsonPath);
        expect(buf.toString("utf-8").trim().split("\n").map((l) => JSON.parse(l).payload._id))
            .toEqual(["a", "b", "c"]);

        // Every stored offset/length must slice the exact entry bytes back out.
        const db = openDayDb(dayDbPath(root, "am-authentication", "2026-06-02"));
        const rows = queryDay(db, {});
        expect(rows).toHaveLength(3);
        for (const r of rows) {
            const slice = buf.subarray(r.offset, r.offset + r.length).toString("utf-8");
            expect(JSON.parse(slice).payload._id).toBe(r.id);
        }
        db.close();
    });
});
