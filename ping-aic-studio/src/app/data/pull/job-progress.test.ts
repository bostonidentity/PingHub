import { describe, it, expect } from "vitest";
import { rowFraction, computeOverall } from "./job-progress";
import type { JobCardRow } from "./JobCard";

const row = (p: Partial<JobCardRow>): JobCardRow => ({
  label: "x", fetched: 0, expected: null, status: "pending", ...p,
});

describe("rowFraction", () => {
  it("done → 1 regardless of counts", () => {
    expect(rowFraction(row({ status: "done", fetched: 5, expected: 10 }))).toBe(1);
  });
  it("uses explicit coverage (logs) clamped to [0,1]", () => {
    expect(rowFraction(row({ status: "running", coverage: 0.4 }))).toBe(0.4);
    expect(rowFraction(row({ status: "running", coverage: 1.5 }))).toBe(1);
  });
  it("falls back to count ratio (managed)", () => {
    expect(rowFraction(row({ status: "running", fetched: 25, expected: 100 }))).toBe(0.25);
  });
  it("null when no denominator and not done", () => {
    expect(rowFraction(row({ status: "running" }))).toBeNull();
  });
});

describe("computeOverall — logs", () => {
  it("is the mean of per-source coverage", () => {
    const rows = [
      row({ status: "done", fetched: 1000 }),           // 1.0
      row({ status: "running", coverage: 0.5, fetched: 40 }), // 0.5
      row({ status: "pending", coverage: 0 }),          // 0
    ];
    const o = computeOverall("logs", rows);
    expect(o.pct).toBe(50);          // mean(1, .5, 0) = .5
    expect(o.count).toBe(1040);      // Σ stored
    expect(o.doneUnits).toBe(1);
    expect(o.totalUnits).toBe(3);
    expect(o.exact).toBe(true);
  });
});

describe("computeOverall — managed", () => {
  it("count-weights Σfetched/Σtotal when all totals known", () => {
    const rows = [
      row({ status: "running", fetched: 50, expected: 100 }),
      row({ status: "running", fetched: 150, expected: 300 }),
    ];
    const o = computeOverall("managed", rows);
    expect(o.pct).toBe(50);          // 200 / 400
    expect(o.count).toBe(200);
    expect(o.exact).toBe(true);
  });

  it("done rows count as fully complete in the weighted total", () => {
    const rows = [
      row({ status: "done", fetched: 80, expected: 100 }),   // counts as 100/100
      row({ status: "pending", fetched: 0, expected: 100 }),
    ];
    expect(computeOverall("managed", rows).pct).toBe(50);    // (100 + 0) / 200
  });

  it("falls back to done/total units (exact:false) when a total is unknown", () => {
    const rows = [
      row({ status: "done", fetched: 500, expected: 500 }),
      row({ status: "running", fetched: 999, expected: null }), // unknown total
    ];
    const o = computeOverall("managed", rows);
    expect(o.pct).toBe(50);          // 1 of 2 units done
    expect(o.exact).toBe(false);
  });
});
