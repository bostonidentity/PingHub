import type { MemberStatus, Overall, ProbeResult } from "./types";

export interface Aggregate {
  overall: Overall;
  okCount: number;
  totalCount: number;
}

function classify(okCount: number, totalCount: number): Overall {
  if (totalCount === 0) return "empty";
  if (okCount === totalCount) return "ok";
  if (okCount === 0) return "down";
  return "degraded";
}

export function aggregateCluster(probes: ProbeResult[]): Aggregate {
  const totalCount = probes.length;
  const okCount = probes.reduce((n, p) => n + (p.ok ? 1 : 0), 0);
  return { overall: classify(okCount, totalCount), okCount, totalCount };
}

export function aggregateFromMembers(members: MemberStatus[]): Aggregate {
  const totalCount = members.length;
  const okCount = members.reduce((n, m) => n + (m.ok && !m.orphan ? 1 : 0), 0);
  return { overall: classify(okCount, totalCount), okCount, totalCount };
}
