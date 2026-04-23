import type { Overall, ProbeResult } from "./types";

export interface Aggregate {
  overall: Overall;
  okCount: number;
  totalCount: number;
}

export function aggregateCluster(probes: ProbeResult[]): Aggregate {
  const totalCount = probes.length;
  const okCount = probes.reduce((n, p) => n + (p.ok ? 1 : 0), 0);
  let overall: Overall;
  if (totalCount === 0) overall = "empty";
  else if (okCount === totalCount) overall = "ok";
  else if (okCount === 0) overall = "down";
  else overall = "degraded";
  return { overall, okCount, totalCount };
}
