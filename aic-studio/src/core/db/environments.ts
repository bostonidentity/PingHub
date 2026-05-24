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
