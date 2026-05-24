// src/core/db/savedLogQueries.ts
import type { Database } from "better-sqlite3";

export interface SaveQueryInput {
  envName: string;
  name: string;
  source: string;
  filterExpr?: string;
}

export interface SavedLogQueryRow {
  id: number;
  envName: string;
  name: string;
  source: string;
  filterExpr?: string;
  createdAt: number;
  lastRunAt?: number;
}

interface RawRow {
  id: number;
  env_name: string;
  name: string;
  source: string;
  filter_expr: string | null;
  created_at: number;
  last_run_at: number | null;
}

function rowToQuery(r: RawRow): SavedLogQueryRow {
  return {
    id: r.id,
    envName: r.env_name,
    name: r.name,
    source: r.source,
    filterExpr: r.filter_expr ?? undefined,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at ?? undefined
  };
}

export function saveQuery(db: Database, input: SaveQueryInput): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO saved_log_queries (env_name, name, source, filter_expr, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.envName, input.name, input.source, input.filterExpr ?? null, now);
  return Number(info.lastInsertRowid);
}

export function getSavedQuery(db: Database, id: number): SavedLogQueryRow | undefined {
  const row = db.prepare("SELECT * FROM saved_log_queries WHERE id = ?").get(id) as RawRow | undefined;
  return row ? rowToQuery(row) : undefined;
}

export function listSavedQueries(db: Database, envName: string): SavedLogQueryRow[] {
  const rows = db.prepare(`
    SELECT * FROM saved_log_queries WHERE env_name = ? ORDER BY name ASC
  `).all(envName) as RawRow[];
  return rows.map(rowToQuery);
}

export function updateLastRun(db: Database, id: number): void {
  db.prepare("UPDATE saved_log_queries SET last_run_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function deleteSavedQuery(db: Database, id: number): void {
  db.prepare("DELETE FROM saved_log_queries WHERE id = ?").run(id);
}
