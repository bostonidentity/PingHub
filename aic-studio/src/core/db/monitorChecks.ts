// src/core/db/monitorChecks.ts
import type { Database } from "better-sqlite3";

export type CheckStatus = "ok" | "warning" | "error";
export type AlertSeverity = "info" | "warning" | "error";

export interface MonitorCheckInput {
  envName: string;
  checkType: string;
  status: CheckStatus;
  detail?: string;
  daysRemaining?: number;
}

export interface MonitorCheckRow {
  id: number;
  envName: string;
  checkType: string;
  status: CheckStatus;
  detail?: string;
  checkedAt: number;
  daysRemaining?: number;
}

export interface AlertInput {
  envName: string;
  checkType: string;
  severity: AlertSeverity;
  message: string;
}

export interface AlertRow {
  id: number;
  envName: string;
  checkType: string;
  severity: AlertSeverity;
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  acknowledgedAt?: number;
}

interface RawCheck {
  id: number;
  env_name: string;
  check_type: string;
  status: string;
  detail: string | null;
  checked_at: number;
  days_remaining: number | null;
}

interface RawAlert {
  id: number;
  env_name: string;
  check_type: string;
  severity: string;
  message: string;
  first_seen_at: number;
  last_seen_at: number;
  acknowledged_at: number | null;
}

function rowToCheck(r: RawCheck): MonitorCheckRow {
  return {
    id: r.id,
    envName: r.env_name,
    checkType: r.check_type,
    status: r.status as CheckStatus,
    detail: r.detail ?? undefined,
    checkedAt: r.checked_at,
    daysRemaining: r.days_remaining ?? undefined
  };
}

function rowToAlert(r: RawAlert): AlertRow {
  return {
    id: r.id,
    envName: r.env_name,
    checkType: r.check_type,
    severity: r.severity as AlertSeverity,
    message: r.message,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedAt: r.acknowledged_at ?? undefined
  };
}

export function recordCheck(db: Database, input: MonitorCheckInput): void {
  db.prepare(`
    INSERT INTO monitor_checks (env_name, check_type, status, detail, checked_at, days_remaining)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.envName, input.checkType, input.status,
    input.detail ?? null, Date.now(), input.daysRemaining ?? null
  );
}

export function latestCheck(db: Database, envName: string, checkType: string): MonitorCheckRow | undefined {
  const row = db.prepare(`
    SELECT * FROM monitor_checks WHERE env_name = ? AND check_type = ?
    ORDER BY checked_at DESC, id DESC LIMIT 1
  `).get(envName, checkType) as RawCheck | undefined;
  return row ? rowToCheck(row) : undefined;
}

export function listChecks(db: Database, envName: string, checkType: string, limit = 100): MonitorCheckRow[] {
  const rows = db.prepare(`
    SELECT * FROM monitor_checks WHERE env_name = ? AND check_type = ?
    ORDER BY checked_at DESC, id DESC LIMIT ?
  `).all(envName, checkType, limit) as RawCheck[];
  return rows.map(rowToCheck);
}

export function recordAlert(db: Database, input: AlertInput): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO monitor_alerts (env_name, check_type, severity, message, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.envName, input.checkType, input.severity, input.message, now, now);
}

export function acknowledgeAlert(db: Database, id: number): void {
  db.prepare("UPDATE monitor_alerts SET acknowledged_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function listActiveAlerts(db: Database, envName: string): AlertRow[] {
  const rows = db.prepare(`
    SELECT * FROM monitor_alerts WHERE env_name = ? AND acknowledged_at IS NULL
    ORDER BY last_seen_at DESC
  `).all(envName) as RawAlert[];
  return rows.map(rowToAlert);
}
