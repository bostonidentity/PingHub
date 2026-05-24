import type { Database } from "better-sqlite3";

export type OpStatus = "running" | "success" | "failure";

export interface StartOpInput {
  envName: string;
  opKind: string;
  scope?: string;
  snapshotDir?: string;
}

export interface OpRow {
  id: number;
  envName: string;
  opKind: string;
  scope?: string;
  status: OpStatus;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  snapshotDir?: string;
}

interface RawRow {
  id: number;
  env_name: string;
  op_kind: string;
  scope: string | null;
  status: string;
  message: string | null;
  started_at: number;
  finished_at: number | null;
  snapshot_dir: string | null;
}

function rowToOp(r: RawRow): OpRow {
  return {
    id: r.id,
    envName: r.env_name,
    opKind: r.op_kind,
    scope: r.scope ?? undefined,
    status: r.status as OpStatus,
    message: r.message ?? undefined,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    snapshotDir: r.snapshot_dir ?? undefined
  };
}

export function startOperation(db: Database, input: StartOpInput): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO op_history (env_name, op_kind, scope, status, started_at, snapshot_dir)
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(input.envName, input.opKind, input.scope ?? null, now, input.snapshotDir ?? null);
  return Number(info.lastInsertRowid);
}

export function finishOperation(
  db: Database,
  id: number,
  status: OpStatus,
  message?: string
): void {
  db.prepare(`
    UPDATE op_history SET status = ?, message = ?, finished_at = ? WHERE id = ?
  `).run(status, message ?? null, Date.now(), id);
}

export function listOperations(db: Database, envName: string, limit = 100): OpRow[] {
  const rows = db.prepare(`
    SELECT * FROM op_history WHERE env_name = ? ORDER BY id DESC LIMIT ?
  `).all(envName, limit) as RawRow[];
  return rows.map(rowToOp);
}
