import { describe, it, expect } from "vitest";
import { aggregateCluster } from "@/lib/rcs/aggregate";
import type { ProbeResult } from "@/lib/rcs/types";

const ok = (name: string): ProbeResult => ({ name, ok: true, latencyMs: 10 });
const fail = (name: string, error = "timeout"): ProbeResult => ({ name, ok: false, latencyMs: 5000, error });

describe("aggregateCluster", () => {
  it("returns 'empty' when no probes were run", () => {
    expect(aggregateCluster([])).toEqual({ overall: "empty", okCount: 0, totalCount: 0 });
  });

  it("returns 'ok' when every probe succeeded", () => {
    expect(aggregateCluster([ok("a"), ok("b")])).toEqual({ overall: "ok", okCount: 2, totalCount: 2 });
  });

  it("returns 'down' when every probe failed", () => {
    expect(aggregateCluster([fail("a"), fail("b")])).toEqual({ overall: "down", okCount: 0, totalCount: 2 });
  });

  it("returns 'degraded' on mixed success and failure", () => {
    expect(aggregateCluster([ok("a"), fail("b"), ok("c")])).toEqual({
      overall: "degraded",
      okCount: 2,
      totalCount: 3,
    });
  });
});
