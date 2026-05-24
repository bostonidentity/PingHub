import type { Database } from "better-sqlite3";
import type { Environment, NewEnvironment } from "../env/types";
import { EnvironmentSchema, NewEnvironmentSchema } from "../env/types";

interface Row {
  name: string;
  label: string;
  tenant_url: string;
  username: string;
  client_id: string;
  color: string;
  created_at: number;
  updated_at: number;
}

function rowToEnvironment(row: Row): Environment {
  return EnvironmentSchema.parse({
    name: row.name,
    label: row.label,
    tenantUrl: row.tenant_url,
    username: row.username,
    clientId: row.client_id,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function insertEnvironment(db: Database, input: NewEnvironment): void {
  const parsed = NewEnvironmentSchema.parse(input);
  const now = Date.now();
  db.prepare(`
    INSERT INTO environments (name, label, tenant_url, username, client_id, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(parsed.name, parsed.label, parsed.tenantUrl, parsed.username, parsed.clientId, parsed.color, now, now);
}

export function getEnvironmentByName(db: Database, name: string): Environment | undefined {
  const row = db.prepare("SELECT * FROM environments WHERE name = ?").get(name) as Row | undefined;
  return row ? rowToEnvironment(row) : undefined;
}

export function listEnvironments(db: Database): Environment[] {
  const rows = db.prepare("SELECT * FROM environments ORDER BY name ASC").all() as Row[];
  return rows.map(rowToEnvironment);
}

export function removeEnvironment(db: Database, name: string): void {
  db.prepare("DELETE FROM environments WHERE name = ?").run(name);
}

const ACTIVE_ENV_KEY = "active_environment";

export function setActiveEnvironment(db: Database, name: string | null): void {
  if (name === null) {
    db.prepare("DELETE FROM app_state WHERE key = ?").run(ACTIVE_ENV_KEY);
    return;
  }
  const exists = getEnvironmentByName(db, name);
  if (!exists) {
    throw new Error(`no such environment: ${name}`);
  }
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ACTIVE_ENV_KEY, name);
}

export function getActiveEnvironment(db: Database): string | undefined {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(ACTIVE_ENV_KEY) as { value: string } | undefined;
  return row?.value;
}
