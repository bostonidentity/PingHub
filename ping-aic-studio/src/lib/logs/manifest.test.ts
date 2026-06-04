import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { mergeRanges, addCoveredRange, readManifest, writeManifest, rangeCoverage, trimCoveredPrefix } from "./manifest";
import type { LogArchiveManifest } from "./log-types";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-manifest-"));
}

describe("mergeRanges", () => {
    it("merges overlapping ranges", () => {
        const merged = mergeRanges([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T12:00:00Z" },
            { from: "2026-06-01T06:00:00Z", to: "2026-06-01T18:00:00Z" },
        ]);
        expect(merged).toEqual([{ from: "2026-06-01T00:00:00Z", to: "2026-06-01T18:00:00Z" }]);
    });

    it("merges adjacent/touching ranges", () => {
        const merged = mergeRanges([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T12:00:00Z" },
            { from: "2026-06-01T12:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
        expect(merged).toEqual([{ from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" }]);
    });

    it("keeps disjoint ranges separate and sorted", () => {
        const merged = mergeRanges([
            { from: "2026-06-03T00:00:00Z", to: "2026-06-03T01:00:00Z" },
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T01:00:00Z" },
        ]);
        expect(merged).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T01:00:00Z" },
            { from: "2026-06-03T00:00:00Z", to: "2026-06-03T01:00:00Z" },
        ]);
    });
});

describe("addCoveredRange", () => {
    it("folds a new range into a source and advances lastPulledTo", () => {
        const m: LogArchiveManifest = { sources: {} };
        const updated = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(updated.sources["am-access"].coveredRanges).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
        expect(updated.sources["am-access"].lastPulledTo).toBe("2026-06-02T00:00:00Z");
    });

    it("does not move lastPulledTo backwards", () => {
        let m: LogArchiveManifest = { sources: {} };
        m = addCoveredRange(m, "am-access", { from: "2026-06-05T00:00:00Z", to: "2026-06-06T00:00:00Z" });
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(m.sources["am-access"].lastPulledTo).toBe("2026-06-06T00:00:00Z");
    });

    it("merges a new range into a source that already has disjoint ranges", () => {
        let m: LogArchiveManifest = { sources: {} };
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-01T06:00:00Z" });
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T18:00:00Z", to: "2026-06-02T00:00:00Z" });
        // [A, C] disjoint — now add B that overlaps both.
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T05:00:00Z", to: "2026-06-01T19:00:00Z" });
        expect(m.sources["am-access"].coveredRanges).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
    });

    it("does not mutate the input manifest", () => {
        const m: LogArchiveManifest = { sources: {} };
        addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(m).toEqual({ sources: {} });
    });
});

describe("readManifest / writeManifest", () => {
    it("returns an empty manifest when the file is absent", () => {
        const root = tmpRoot();
        expect(readManifest(root)).toEqual({ sources: {} });
    });

    it("round-trips write then read", () => {
        const root = tmpRoot();
        const m = addCoveredRange({ sources: {} }, "am-core", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        writeManifest(root, m);
        expect(readManifest(root)).toEqual(m);
    });

    it("returns an empty manifest when the file is corrupt JSON", () => {
        const root = tmpRoot();
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "manifest.json"), "{ not valid json");
        expect(readManifest(root)).toEqual({ sources: {} });
    });

    it("returns an empty manifest when sources is not an object", () => {
        const root = tmpRoot();
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ sources: "nope" }));
        expect(readManifest(root)).toEqual({ sources: {} });
    });
});

describe("trimCoveredPrefix", () => {
    it("returns `from` when nothing is covered", () => {
        expect(trimCoveredPrefix([], "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T00:00:00Z");
    });
    it("returns null when [from,to] is fully covered", () => {
        const c = [{ from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBeNull();
    });
    it("advances past a covered prefix to the first uncovered point", () => {
        const c = [{ from: "2026-06-02T00:00:00Z", to: "2026-06-02T06:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T06:00:00Z");
    });
    it("merges adjacent covered prefixes", () => {
        const c = [
            { from: "2026-06-02T00:00:00Z", to: "2026-06-02T06:00:00Z" },
            { from: "2026-06-02T06:00:00Z", to: "2026-06-02T12:00:00Z" },
        ];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T12:00:00Z");
    });
    it("does not advance for a mid-window hole that doesn't touch `from`", () => {
        const c = [{ from: "2026-06-02T10:00:00Z", to: "2026-06-02T11:00:00Z" }];
        expect(trimCoveredPrefix(c, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe("2026-06-02T00:00:00Z");
    });
});

describe("rangeCoverage", () => {
    const ranges = [
        { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        { from: "2026-06-04T00:00:00Z", to: "2026-06-05T00:00:00Z" },
    ];
    it("returns 'none' when the window is outside every covered range", () => {
        expect(rangeCoverage(ranges, "2026-06-03T00:00:00Z", "2026-06-03T12:00:00Z")).toBe("none");
        expect(rangeCoverage([], "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBe("none");
    });
    it("returns 'full' when a single covered range contains the window", () => {
        expect(rangeCoverage(ranges, "2026-06-01T06:00:00Z", "2026-06-01T18:00:00Z")).toBe("full");
        expect(rangeCoverage(ranges, "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBe("full");
    });
    it("returns 'partial' when the window only overlaps part of the coverage", () => {
        expect(rangeCoverage(ranges, "2026-06-01T12:00:00Z", "2026-06-03T00:00:00Z")).toBe("partial");
        // spans the gap between the two ranges
        expect(rangeCoverage(ranges, "2026-06-01T12:00:00Z", "2026-06-04T12:00:00Z")).toBe("partial");
    });
});
