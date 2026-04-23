import { describe, it, expect } from "vitest";
import { isStaleToday } from "@/lib/release/staleness";

const NOW = new Date("2026-04-23T12:00:00Z");

describe("isStaleToday", () => {
  it("returns true when fetchedAt is missing or null", () => {
    expect(isStaleToday(undefined, NOW)).toBe(true);
    expect(isStaleToday(null, NOW)).toBe(true);
    expect(isStaleToday("", NOW)).toBe(true);
  });

  it("returns true when fetchedAt is malformed", () => {
    expect(isStaleToday("not-a-date", NOW)).toBe(true);
  });

  it("returns true when fetchedAt is from a previous UTC day", () => {
    expect(isStaleToday("2026-04-22T23:59:59Z", NOW)).toBe(true);
    expect(isStaleToday("2026-04-01T00:00:00Z", NOW)).toBe(true);
  });

  it("returns false when fetchedAt is the same UTC calendar day", () => {
    expect(isStaleToday("2026-04-23T00:00:01Z", NOW)).toBe(false);
    expect(isStaleToday("2026-04-23T23:59:59Z", NOW)).toBe(false);
  });

  it("treats a future-dated fetchedAt as fresh (not stale)", () => {
    expect(isStaleToday("2026-04-24T00:00:01Z", NOW)).toBe(false);
  });
});
