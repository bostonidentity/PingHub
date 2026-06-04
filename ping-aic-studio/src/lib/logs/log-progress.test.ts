import { describe, it, expect } from "vitest";
import { timeCoverageFraction } from "./log-progress";

const FROM = "2026-06-03T00:00:00Z";
const TO = "2026-06-04T00:00:00Z"; // 24h window

describe("timeCoverageFraction", () => {
  it("is 1 when the source is done (window fully pulled)", () => {
    expect(timeCoverageFraction(FROM, TO, undefined, "done")).toBe(1);
    // even with a mid-window lastTimestamp, done means complete
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T06:00:00Z", "done")).toBe(1);
  });

  it("is 0 when pending", () => {
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T12:00:00Z", "pending")).toBe(0);
  });

  it("is the time fraction through the window while running", () => {
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T06:00:00Z", "running")).toBe(0.25);
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T12:00:00Z", "running")).toBe(0.5);
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T18:00:00Z", "running")).toBe(0.75);
  });

  it("is 0 while running before the first event arrives", () => {
    expect(timeCoverageFraction(FROM, TO, undefined, "running")).toBe(0);
  });

  it("clamps to [0,1] for out-of-window timestamps", () => {
    expect(timeCoverageFraction(FROM, TO, "2026-06-02T00:00:00Z", "running")).toBe(0); // before from
    expect(timeCoverageFraction(FROM, TO, "2026-06-05T00:00:00Z", "running")).toBe(1); // after to
  });

  it("returns null (indeterminate) for a failed source with no event", () => {
    expect(timeCoverageFraction(FROM, TO, undefined, "failed")).toBeNull();
  });

  it("shows partial coverage for a failed source that got partway", () => {
    expect(timeCoverageFraction(FROM, TO, "2026-06-03T12:00:00Z", "failed")).toBe(0.5);
  });

  it("returns null for unparseable or zero-length windows", () => {
    expect(timeCoverageFraction("nope", TO, "2026-06-03T12:00:00Z", "running")).toBeNull();
    expect(timeCoverageFraction(TO, FROM, "2026-06-03T12:00:00Z", "running")).toBeNull(); // to <= from
    expect(timeCoverageFraction(FROM, FROM, FROM, "running")).toBeNull();
  });
});
