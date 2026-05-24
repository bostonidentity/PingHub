export const SCHEMA_VERSION = 2;

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
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS op_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        scope TEXT,
        status TEXT NOT NULL,
        message TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        snapshot_dir TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_op_history_env ON op_history(env_name, started_at DESC);
    `
  }
] as const;
