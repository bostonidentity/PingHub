// src/core/dashboard/summary.ts
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../db/environments";
import { listOperations } from "../db/opHistory";
import { listActiveAlerts } from "../db/monitorChecks";
import { listAllSnapshotsForEnv } from "../snapshots/paths";

export interface EnvSummary {
  envName: string;
  envLabel: string;
  lastPullAt?: number;
  snapshotCount: number;
  recentOpCount: number;
  hasMonitorAlerts: boolean;
}

export interface DashboardSummary {
  envs: EnvSummary[];
  totalRecentOps: number;
  totalAlerts: number;
}

export function buildDashboardSummary(db: Database, globalStoragePath: string): DashboardSummary {
  const envs = listEnvironments(db);
  const oneWeekAgo = Date.now() - 7 * 86400000;
  let totalAlerts = 0;
  const summaries: EnvSummary[] = envs.map((env) => {
    const ops = listOperations(db, env.name, 100);
    const recent = ops.filter((o) => o.startedAt >= oneWeekAgo);
    const lastPull = ops.find((o) => o.opKind === "pull");
    const snapshots = listAllSnapshotsForEnv(globalStoragePath, env.name);
    const alerts = listActiveAlerts(db, env.name);
    totalAlerts += alerts.length;
    return {
      envName: env.name,
      envLabel: env.label,
      lastPullAt: lastPull?.startedAt,
      snapshotCount: snapshots.length,
      recentOpCount: recent.length,
      hasMonitorAlerts: alerts.length > 0
    };
  });
  return {
    envs: summaries,
    totalRecentOps: summaries.reduce((a, s) => a + s.recentOpCount, 0),
    totalAlerts
  };
}
