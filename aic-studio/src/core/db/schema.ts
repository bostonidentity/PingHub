export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        tenant_url TEXT NOT NULL,
        username TEXT NOT NULL,
        client_id TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
] as const;
