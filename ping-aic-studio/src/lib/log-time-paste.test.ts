import { describe, expect, it } from "vitest";
import { parsePastedTimestamp } from "./log-time-paste";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("parsePastedTimestamp", () => {
    it("reads an AIC log timestamp to the millisecond", () => {
        expect(iso(parsePastedTimestamp("2026-10-13T02:08:30.383Z", "local"))).toBe("2026-10-13T02:08:30.383Z");
        expect(iso(parsePastedTimestamp("2026-10-13T02:08:30Z", "local"))).toBe("2026-10-13T02:08:30.000Z");
    });

    it("honours an explicit offset and strips surrounding quotes", () => {
        expect(iso(parsePastedTimestamp('"2026-10-13T04:08:30.383+02:00"', "local"))).toBe("2026-10-13T02:08:30.383Z");
    });

    it("reads epoch seconds and milliseconds", () => {
        expect(iso(parsePastedTimestamp("1791856110", "local"))).toBe("2026-10-13T01:48:30.000Z");
        expect(iso(parsePastedTimestamp("1791856110383", "local"))).toBe("2026-10-13T01:48:30.383Z");
    });

    it("reads a zoneless time in the display zone", () => {
        expect(iso(parsePastedTimestamp("2026-10-13 02:08:30.383", "utc"))).toBe("2026-10-13T02:08:30.383Z");
        const local = parsePastedTimestamp("2026-10-13 02:08", "local");
        expect(local?.getHours()).toBe(2);
        expect(local?.getMinutes()).toBe(8);
    });

    it("returns null for text that is not a timestamp", () => {
        expect(parsePastedTimestamp("yesterday", "local")).toBeNull();
        expect(parsePastedTimestamp("2026-10-13", "local")).toBeNull();
        expect(parsePastedTimestamp("2026-13-45T99:99:99Z", "local")).toBeNull();
    });
});
