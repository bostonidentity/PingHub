import { describe, it, expect } from "vitest";
import { aggregateCluster, aggregateFromMembers } from "@/lib/rcs/aggregate";
import type { MemberStatus, ProbeResult } from "@/lib/rcs/types";

const ok = (name: string): ProbeResult => ({ name, ok: true, latencyMs: 10 });
const fail = (name: string, error = "timeout"): ProbeResult => ({ name, ok: false, latencyMs: 5000, error });
const mOk = (name: string): MemberStatus => ({ name, ok: true, latencyMs: 5 });
const mFail = (name: string, error = "waiting"): MemberStatus => ({ name, ok: false, latencyMs: 0, error });

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

describe("aggregateFromMembers", () => {
  it("returns 'empty' when no members provided", () => {
    expect(aggregateFromMembers([])).toEqual({ overall: "empty", okCount: 0, totalCount: 0 });
  });

  it("returns 'ok' when every member is ok=true", () => {
    expect(aggregateFromMembers([mOk("a"), mOk("b")])).toEqual({
      overall: "ok",
      okCount: 2,
      totalCount: 2,
    });
  });

  it("returns 'down' when every member is ok=false", () => {
    expect(aggregateFromMembers([mFail("a"), mFail("b")])).toEqual({
      overall: "down",
      okCount: 0,
      totalCount: 2,
    });
  });

  it("returns 'degraded' on mixed ok/not-ok members", () => {
    expect(aggregateFromMembers([mOk("a"), mFail("b"), mOk("c")])).toEqual({
      overall: "degraded",
      okCount: 2,
      totalCount: 3,
    });
  });

  it("treats orphan members as not-ok regardless of their ok field", () => {
    const orphan: MemberStatus = { name: "ghost", ok: false, latencyMs: 0, orphan: true, error: "not in remoteConnectorClients" };
    expect(aggregateFromMembers([mOk("a"), orphan])).toEqual({
      overall: "degraded",
      okCount: 1,
      totalCount: 2,
    });
  });
});
