import { describe, it, expect } from "vitest";
import { classifyUpgrade, daysUntil } from "@/lib/release/urgency";

const NOW = new Date("2026-04-23T12:00:00Z").getTime();

describe("classifyUpgrade", () => {
  it("returns 'unknown' when nextUpgrade is null or missing", () => {
    expect(classifyUpgrade(null, NOW)).toBe("unknown");
  });

  it("returns 'overdue' when nextUpgrade is in the past", () => {
    expect(classifyUpgrade("2026-04-22T00:00:00Z", NOW)).toBe("overdue");
  });

  it("returns 'soon' when upgrade is within 14 days (default threshold)", () => {
    expect(classifyUpgrade("2026-04-28T00:00:00Z", NOW)).toBe("soon");
    expect(classifyUpgrade("2026-05-06T00:00:00Z", NOW)).toBe("soon");
  });

  it("returns 'later' when upgrade is more than 14 days out", () => {
    expect(classifyUpgrade("2026-06-01T00:00:00Z", NOW)).toBe("later");
  });

  it("boundary: exactly 14 days from now counts as 'soon'", () => {
    expect(classifyUpgrade("2026-05-07T12:00:00Z", NOW)).toBe("soon");
  });

  it("accepts a custom threshold", () => {
    expect(classifyUpgrade("2026-04-28T00:00:00Z", NOW, { soonDays: 3 })).toBe("later");
    expect(classifyUpgrade("2026-04-25T00:00:00Z", NOW, { soonDays: 3 })).toBe("soon");
  });

  it("treats malformed date strings as 'unknown'", () => {
    expect(classifyUpgrade("not-a-date", NOW)).toBe("unknown");
  });
});

describe("daysUntil", () => {
  it("returns whole-day diffs rounded toward zero", () => {
    expect(daysUntil("2026-04-28T00:00:00Z", NOW)).toBe(4);
    expect(daysUntil("2026-04-22T00:00:00Z", NOW)).toBe(-2);
  });

  it("returns null for invalid input", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("junk", NOW)).toBeNull();
  });
});
