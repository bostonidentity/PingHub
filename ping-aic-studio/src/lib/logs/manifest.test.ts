import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { mergeRanges, addCoveredRange, readManifest, writeManifest } from "./manifest";

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

    it("addCoveredRange folds a new range into a source and advances lastPulledTo", () => {
        const m = { sources: {} };
        const updated = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(updated.sources["am-access"].coveredRanges).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
        expect(updated.sources["am-access"].lastPulledTo).toBe("2026-06-02T00:00:00Z");
    });

    it("addCoveredRange does not move lastPulledTo backwards", () => {
        let m = { sources: {} };
        m = addCoveredRange(m, "am-access", { from: "2026-06-05T00:00:00Z", to: "2026-06-06T00:00:00Z" });
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(m.sources["am-access"].lastPulledTo).toBe("2026-06-06T00:00:00Z");
    });

    it("readManifest returns an empty manifest when the file is absent", () => {
        const root = tmpRoot();
        expect(readManifest(root)).toEqual({ sources: {} });
    });

    it("writeManifest then readManifest round-trips", () => {
        const root = tmpRoot();
        const m = addCoveredRange({ sources: {} }, "am-core", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        writeManifest(root, m);
        expect(readManifest(root)).toEqual(m);
    });
});
