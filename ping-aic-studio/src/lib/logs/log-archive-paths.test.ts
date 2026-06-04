import { describe, it, expect } from "vitest";
import path from "node:path";
import { dayKey, sourceDir, dayNdjsonPath, dayDbPath, manifestPath, logDataDir } from "./log-archive-paths";

describe("log-archive-paths", () => {
    it("derives a UTC day key from an ISO timestamp with nanoseconds", () => {
        expect(dayKey("2026-06-02T00:00:00.005593365Z")).toBe("2026-06-02");
    });

    it("derives the UTC day even when the instant is late in the day UTC", () => {
        expect(dayKey("2026-06-02T23:59:59.999Z")).toBe("2026-06-02");
    });

    it("throws on an unparseable timestamp", () => {
        expect(() => dayKey("not-a-date")).toThrow(/invalid timestamp/);
    });

    it("builds source/day paths under the archive root", () => {
        const root = "/tmp/log-data";
        expect(sourceDir(root, "am-authentication")).toBe(path.join(root, "am-authentication"));
        expect(dayNdjsonPath(root, "am-authentication", "2026-06-02"))
            .toBe(path.join(root, "am-authentication", "2026-06-02.ndjson"));
        expect(dayDbPath(root, "am-authentication", "2026-06-02"))
            .toBe(path.join(root, "am-authentication", "2026-06-02.sqlite"));
        expect(manifestPath(root)).toBe(path.join(root, "manifest.json"));
    });

    it("rejects path-traversal in source names", () => {
        expect(() => sourceDir("/tmp/log-data", "../evil")).toThrow(/invalid source/);
        expect(() => dayNdjsonPath("/tmp/log-data", "am-access", "../../etc")).toThrow(/invalid day/);
    });

    it("rejects a lone dot as a segment", () => {
        expect(() => sourceDir("/tmp/log-data", ".")).toThrow(/invalid source/);
    });

    it("logDataDir rejects an env with path separators", () => {
        expect(() => logDataDir("../evil")).toThrow(/invalid env/);
    });
});
